import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { isBuiltinKey } from '../domain/builtins.js'
import { receiveInbound } from '../domain/inbound.js'
import { Integrations } from '../domain/integration-service.js'
import { MANAGE } from '../domain/object-types.js'

/** Интеграции установки (14-automation-integrations.md §5, ADR-0097). */
export function registerIntegrationRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /integrations',
    auth: { capability: MANAGE },
    tags: ['integrations'],
    summary: 'Интеграции установки: записи реестра и встроенные службы',
    handler: async () => ({ items: await Integrations.list() }),
  })

  route({
    route: 'POST /integrations',
    auth: { capability: MANAGE },
    tags: ['integrations'],
    summary: 'Завести интеграцию',
    handler: async (request) => Integrations.create(request.ctx, request.body),
  })

  route({
    route: 'GET /integrations/:id',
    auth: { action: 'view' },
    tags: ['integrations'],
    summary: 'Карточка интеграции (без значений секретов)',
    handler: async (request) => Integrations.get(request.params.id),
  })

  route({
    route: 'PATCH /integrations/:id',
    auth: { action: 'manage', capability: MANAGE },
    tags: ['integrations'],
    summary: 'Изменить интеграцию или её секреты',
    handler: async (request) => Integrations.update(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'DELETE /integrations/:id',
    auth: { action: 'delete', capability: MANAGE },
    tags: ['integrations'],
    summary: 'Удалить интеграцию',
    handler: async (request) => {
      await Integrations.remove(request.ctx, request.params.id)
      return { ok: true }
    },
  })

  route({
    route: 'POST /integrations/:id/check',
    auth: { action: 'check', capability: MANAGE },
    tags: ['integrations'],
    summary: 'Проверить соединение',
    rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async (request) => Integrations.check(request.ctx, request.params.id),
  })

  route({
    route: 'POST /integrations/:id/inbound-secret',
    auth: { action: 'manage', capability: MANAGE },
    tags: ['integrations'],
    summary: 'Выпустить секрет входящего вебхука: адрес показывается один раз',
    handler: async (request) => Integrations.rotateInboundSecret(request.ctx, request.params.id),
  })

  route({
    route: 'GET /integrations/:id/syncs',
    auth: { action: 'view' },
    tags: ['integrations'],
    summary: 'Журнал синхронизаций интеграции',
    handler: async (request) => ({
      items: await Integrations.syncs(request.params.id, request.query.limit),
    }),
  })

  route({
    route: 'POST /integrations/builtin/:key/check',
    auth: { capability: MANAGE },
    tags: ['integrations'],
    summary: 'Проверить соединение встроенной службы (SMTP, Telegram)',
    rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async (request) => {
      if (!isBuiltinKey(request.params.key)) throw errors.notFound('Встроенная интеграция')
      return Integrations.checkBuiltin(request.ctx, request.params.key)
    },
  })

  route({
    route: 'POST /hooks/:integrationId/:secret',
    // Входящий вебхук проверяется секретом самой интеграции; доступа к данным
    // он не даёт — только публикует факт `webhook.received` (ADR-0097)
    auth: 'public',
    tags: ['integrations'],
    summary: 'Входящий вебхук интеграции',
    description:
      'Публикует событие `webhook.received`; его подхватывают правила автоматизации. ' +
      'Неизвестная интеграция, выключенный вход и неверный секрет отвечают одинаково — 404.',
    rateLimit: {
      max: 600,
      timeWindow: '1 minute',
      keyGenerator: (request) =>
        `hook:${(request.params as { integrationId?: string }).integrationId ?? ''}`,
    },
    handler: async (request, reply) => {
      const signature = request.headers['x-hub-signature-256'] ?? request.headers['x-signature']
      const result = await receiveInbound({
        integrationId: request.params.integrationId,
        secret: request.params.secret,
        body: request.body,
        signature: typeof signature === 'string' ? signature : null,
        ip: request.ip ?? null,
      })
      reply.code(202)
      return result
    },
  })
}
