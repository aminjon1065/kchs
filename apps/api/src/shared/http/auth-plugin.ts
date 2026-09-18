import type { Capability, Locale } from '@kchs/contracts'
import { normalizeLocale } from '@kchs/i18n'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { config } from '../config/index.js'
import type { UserCtx } from '../context.js'
import { errors } from '../errors.js'
import type { RouteAuth } from './route.js'

declare module 'fastify' {
  interface FastifyRequest {
    ctx: UserCtx
  }
  interface FastifyContextConfig {
    auth?: RouteAuth
  }
}

export interface AuthDependencies {
  resolveSession: (token: string) => Promise<{
    sessionId: string
    userId: string
    csrfToken: string
    expiresAt: string
    onBehalfOf: string | null
  } | null>
  buildUserCtx: (
    session: { sessionId: string; userId: string; onBehalfOf: string | null },
    request: FastifyRequest,
  ) => Promise<UserCtx>
  touchSession: (sessionId: string) => Promise<void>
  authorizeRoute: (ctx: UserCtx, action: string, objectId: string) => Promise<void>
  requireCapability: (ctx: UserCtx, capability: string) => void
  resolveShareLink?: (token: string) => Promise<UserCtx | null>
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Аутентификация и применение политики маршрута.
 * Маршрут без `config.auth` не обслуживается: это защита от «забыли проверить»
 * (17-security.md §3).
 */
export const authPlugin = fp<AuthDependencies>(async (app: FastifyInstance, deps) => {
  const env = config()

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.routeOptions?.config?.auth as RouteAuth | undefined

    if (auth === undefined) {
      // Неизвестный маршрут (404) или маршрут без политики
      if (request.routeOptions?.url) {
        request.log.error({ url: request.url }, 'маршрут без политики auth')
        throw errors.internal('Маршрут без политики доступа')
      }
      return
    }

    if (auth === 'public') return

    const token = request.cookies?.[env.SESSION_COOKIE_NAME]
    const shareToken = request.headers['x-kchs-share-token']

    if (!token && typeof shareToken === 'string' && deps.resolveShareLink) {
      const guestCtx = await deps.resolveShareLink(shareToken)
      if (guestCtx) {
        request.ctx = { ...guestCtx, requestId: request.id }
        await applyRoutePolicy(request, auth, deps)
        return
      }
    }

    if (!token) throw errors.unauthorized()

    const session = await deps.resolveSession(token)
    if (!session) {
      reply.clearCookie(env.SESSION_COOKIE_NAME, { path: '/' })
      throw errors.unauthorized('Сессия истекла, войдите заново')
    }

    // CSRF для изменяющих запросов от браузера (17-security.md §5)
    if (!SAFE_METHODS.has(request.method)) {
      const header = request.headers['x-csrf-token']
      if (typeof header !== 'string' || header !== session.csrfToken) {
        throw errors.forbidden('Некорректный CSRF-токен')
      }
    }

    request.ctx = await deps.buildUserCtx(session, request)
    void deps.touchSession(session.sessionId)

    await applyRoutePolicy(request, auth, deps)
  })
})

async function applyRoutePolicy(
  request: FastifyRequest,
  auth: RouteAuth,
  deps: AuthDependencies,
): Promise<void> {
  if (auth === 'session' || auth === 'public') return

  if ('capability' in auth && !('action' in auth)) {
    deps.requireCapability(request.ctx, auth.capability)
    return
  }

  if ('action' in auth) {
    const param = auth.objectParam ?? 'id'
    const params = request.params as Record<string, string> | undefined
    const objectId = params?.[param]
    if (!objectId) throw errors.validation(`В маршруте отсутствует параметр «${param}»`)
    if (auth.capability) deps.requireCapability(request.ctx, auth.capability)
    await deps.authorizeRoute(request.ctx, auth.action, objectId)
  }
}

export function localeOf(request: FastifyRequest): Locale {
  const header = request.headers['accept-language']
  return normalizeLocale(typeof header === 'string' ? header : 'ru')
}

export function capabilitiesOf(values: string[]): Set<Capability> {
  return new Set(values as Capability[])
}
