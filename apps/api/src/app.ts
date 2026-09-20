import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import sensible from '@fastify/sensible'
import swagger from '@fastify/swagger'
import underPressure from '@fastify/under-pressure'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod'
import { auditAdminModeRequest } from '~/kernel/access/admin-mode.js'
import { authorize, requireCapability } from '~/kernel/access/authorize.js'
import { resolveShareLinkCtx } from '~/kernel/access/share-links.js'
import { buildUserCtx } from '~/kernel/context-builder.js'
import { PrintGrants } from '~/kernel/print/grants.js'
import { AuthService } from '~/modules/identity/domain/auth-service.js'
import { registerModules } from '~/modules/index.js'
import { authenticateApiToken, enforceTokenScope } from '~/modules/integrations/public.js'
import { config } from '~/shared/config/index.js'
import { errors } from '~/shared/errors.js'
import { API_DOCS_STYLE, OPENAPI_TAGS, renderApiDocs } from '~/shared/http/api-docs.js'
import { authPlugin } from '~/shared/http/auth-plugin.js'
import { sendProblem } from '~/shared/http/problem.js'
import { routeRegistrar } from '~/shared/http/route.js'
import { telemetryPlugin } from '~/shared/http/telemetry-plugin.js'
import { logger } from '~/shared/logger/index.js'
import { redis } from '~/shared/redis/index.js'

export async function buildApp(): Promise<FastifyInstance> {
  const env = config()

  const app = Fastify({
    loggerInstance: logger() as unknown as FastifyBaseLogger,
    // Адрес клиента берётся из X-Forwarded-For только от доверенного прокси
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 10 * 1024 * 1024,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 12)}`,
    ajv: { customOptions: { removeAdditional: false } },
  })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  app.setErrorHandler((error, request, reply) => {
    sendProblem(request, reply, error)
  })
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).type('application/problem+json').send({
      type: 'https://kchs.local/problems/not_found',
      title: 'Не найдено',
      status: 404,
      code: 'not_found',
      instance: request.url,
    })
  })

  await app.register(telemetryPlugin)
  await app.register(sensible)
  await app.register(cookie, { hook: 'onRequest' })

  await app.register(helmet, {
    contentSecurityPolicy: false, // CSP отдаёт прокси для SPA; API возвращает JSON
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  })

  await app.register(cors, {
    origin: [env.KCHS_BASE_URL],
    credentials: true,
    allowedHeaders: [
      'content-type',
      'x-csrf-token',
      'x-kchs-share-token',
      'x-kchs-on-behalf-of',
      'accept-language',
      'if-match',
      'idempotency-key',
    ],
    exposedHeaders: ['x-kchs-version', 'etag'],
  })

  await app.register(rateLimit, {
    global: true,
    // После аутентификации: лимит считается по пользователю, а не по общему IP
    hook: 'preHandler',
    max: env.NODE_ENV === 'test' ? 1_000_000 : env.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    redis: redis(),
    nameSpace: env.NODE_ENV === 'test' ? 'kchs-rl-test:' : 'kchs-rl:',
    keyGenerator: (request) =>
      (request as { ctx?: { userId: string } }).ctx?.userId ?? request.ip ?? 'anonymous',
    // Ответ 429 — обычная проблема API: локализованный заголовок и время ожидания
    errorResponseBuilder: (_request, context) =>
      errors.rateLimited(Math.max(1, Math.ceil(context.ttl / 1000))),
  })

  // Защита от перегрузки: 503, пока сервис не разгребёт очередь. В тестах
  // выключена — десятки файлов в одном процессе сами задерживают цикл событий,
  // и тогда 503 приходит вместо ответа, который проверяет тест
  if (env.NODE_ENV !== 'test') {
    await app.register(underPressure, {
      maxEventLoopDelay: 2000,
      maxHeapUsedBytes: 1_200_000_000,
      message: 'Сервис перегружен',
      retryAfter: 5,
    })
  }

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'kchs API',
        version: '0.1.0',
        description:
          'Корпоративная рабочая платформа: данные, GIS, документы, задачи, коммуникации. ' +
          'Всё, что умеет интерфейс, доступно через этот API: веб-клиент ходит теми же маршрутами. ' +
          'Аутентификация — cookie-сессия браузера или Authorization: Bearer <токен интеграции>.',
      },
      servers: [{ url: `${env.KCHS_API_URL}/api/v1` }],
      // Схемы предъявляются на каждой операции: cookie-сессия браузера либо
      // токен интеграции (14-automation-integrations.md §3, ADR-0097)
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      tags: [...OPENAPI_TAGS],
      components: {
        securitySchemes: {
          cookieAuth: { type: 'apiKey', in: 'cookie', name: env.SESSION_COOKIE_NAME },
          bearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
    },
    transform: jsonSchemaTransform,
  })

  await app.register(authPlugin, {
    resolveSession: (token) => AuthService.resolveSession(token),
    buildUserCtx,
    touchSession: (sessionId) => AuthService.touchSession(sessionId),
    authorizeRoute: async (ctx, action, objectId) => {
      await authorize(ctx, action, objectId)
    },
    requireCapability,
    resolveShareLink: resolveShareLinkCtx,
    resolvePrintGrant: (token) => PrintGrants.resolve(token),
    resolveApiToken: (request, secret) => authenticateApiToken(request, secret),
    enforceTokenScope,
  })

  // Вебхук медиасервера приходит типом application/webhook+json и проверяется по
  // подписи тела: разбирать его до проверки нельзя (ADR-0092)
  app.addContentTypeParser(
    'application/webhook+json',
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  )

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-kchs-version', '0.1.0')
    return payload
  })

  // Режим администратора (ADR-0080): каждое действие в режиме — в аудит
  app.addHook('onResponse', async (request, reply) => {
    await auditAdminModeRequest(request, reply.statusCode)
  })

  // Служебные маршруты вне /api/v1: в спецификацию публичного API не входят —
  // её база `/api/v1`, и запись о них вводила бы интеграции в заблуждение
  const service = { schema: { hide: true }, config: { auth: 'public' as const } }

  // Здоровье — вне /api/v1, без аутентификации
  app.get('/health', service, async () => ({ status: 'ok' }))
  app.get('/api/openapi.json', service, async () => app.swagger())

  // Публичная документация API (14-automation-integrations.md §3, ADR-0097):
  // серверная страница без скриптов — CSP установки разрешает только свои файлы
  app.get('/api/docs', service, async (_request, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(renderApiDocs(app.swagger() as unknown as Record<string, unknown>)),
  )
  app.get('/api/docs/style.css', service, async (_request, reply) =>
    reply.type('text/css; charset=utf-8').send(API_DOCS_STYLE),
  )

  await app.register(
    async (instance) => {
      const route = routeRegistrar(instance)
      await registerModules(instance, route)
    },
    { prefix: '/api/v1' },
  )

  await app.ready()
  return app
}
