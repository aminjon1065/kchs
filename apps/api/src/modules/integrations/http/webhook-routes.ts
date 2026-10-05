import type { RouteRegistrar } from '~/shared/http/route.js'
import { MANAGE } from '../domain/object-types.js'
import { retryDelivery } from '../domain/webhook-delivery.js'
import { Webhooks } from '../domain/webhook-service.js'

/** Исходящие вебхуки (14-automation-integrations.md §4, ADR-0097). */
export function registerWebhookRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /webhooks',
    auth: { capability: MANAGE },
    tags: ['integrations'],
    summary: 'Исходящие вебхуки установки',
    handler: async () => ({ items: await Webhooks.list() }),
  })

  route({
    route: 'POST /webhooks',
    auth: { capability: MANAGE },
    tags: ['integrations'],
    summary: 'Подписать вебхук на события',
    description:
      'Секрет подписи выдаётся один раз. Тело запроса подписывается HMAC-SHA256 ' +
      'по строке `<x-kchs-timestamp>.<тело>`; подпись — в заголовке `x-kchs-signature`.',
    handler: async (request) => Webhooks.create(request.ctx, request.body),
  })

  route({
    route: 'GET /webhooks/:id',
    auth: { action: 'view' },
    tags: ['integrations'],
    summary: 'Карточка вебхука',
    handler: async (request) => Webhooks.get(request.params.id),
  })

  route({
    route: 'PATCH /webhooks/:id',
    auth: { action: 'manage', capability: MANAGE },
    tags: ['integrations'],
    summary: 'Изменить вебхук, включить или поставить на паузу',
    handler: async (request) => Webhooks.update(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'DELETE /webhooks/:id',
    auth: { action: 'delete', capability: MANAGE },
    tags: ['integrations'],
    summary: 'Удалить вебхук',
    handler: async (request) => {
      await Webhooks.remove(request.ctx, request.params.id)
      return { ok: true }
    },
  })

  route({
    route: 'POST /webhooks/:id/secret',
    auth: { action: 'manage', capability: MANAGE },
    tags: ['integrations'],
    summary: 'Перевыпустить секрет подписи',
    handler: async (request) => ({
      secret: await Webhooks.rotateSecret(request.ctx, request.params.id),
    }),
  })

  route({
    route: 'GET /webhooks/:id/deliveries',
    auth: { action: 'view' },
    tags: ['integrations'],
    summary: 'Журнал доставок вебхука',
    handler: async (request) =>
      Webhooks.deliveries(request.params.id, {
        limit: request.query.limit,
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      }),
  })

  route({
    route: 'POST /webhooks/:id/deliveries/:deliveryId/retry',
    auth: { action: 'manage', capability: MANAGE },
    tags: ['integrations'],
    summary: 'Повторить доставку вручную',
    handler: async (request) => {
      await retryDelivery(request.params.id, request.params.deliveryId)
      return { ok: true }
    },
  })
}
