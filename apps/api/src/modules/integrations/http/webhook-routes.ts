import {
  Webhook,
  WebhookCreateInput,
  WebhookDeliveryList,
  WebhookList,
  WebhookSecret,
  WebhookUpdateInput,
} from '@kchs/contracts'
import { z } from 'zod'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { MANAGE } from '../domain/object-types.js'
import { retryDelivery } from '../domain/webhook-delivery.js'
import { Webhooks } from '../domain/webhook-service.js'

/** Исходящие вебхуки (14-automation-integrations.md §4, ADR-0097). */
export function registerWebhookRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/webhooks',
    auth: { capability: MANAGE },
    tags: ['integrations'],
    summary: 'Исходящие вебхуки установки',
    schema: { response: { 200: WebhookList } },
    handler: async () => ({ items: await Webhooks.list() }),
  })

  route({
    method: 'POST',
    url: '/webhooks',
    auth: { capability: MANAGE },
    tags: ['integrations'],
    summary: 'Подписать вебхук на события',
    description:
      'Секрет подписи выдаётся один раз. Тело запроса подписывается HMAC-SHA256 ' +
      'по строке `<x-kchs-timestamp>.<тело>`; подпись — в заголовке `x-kchs-signature`.',
    schema: {
      body: WebhookCreateInput,
      response: { 200: z.object({ webhook: Webhook, secret: z.string() }) },
    },
    handler: async (request) => Webhooks.create(request.ctx, request.body),
  })

  route({
    method: 'GET',
    url: '/webhooks/:id',
    auth: { action: 'view' },
    tags: ['integrations'],
    summary: 'Карточка вебхука',
    schema: { params: z.object({ id: z.uuid() }), response: { 200: Webhook } },
    handler: async (request) => Webhooks.get(request.params.id),
  })

  route({
    method: 'PATCH',
    url: '/webhooks/:id',
    auth: { action: 'manage', capability: MANAGE },
    tags: ['integrations'],
    summary: 'Изменить вебхук, включить или поставить на паузу',
    schema: {
      params: z.object({ id: z.uuid() }),
      body: WebhookUpdateInput,
      response: { 200: Webhook },
    },
    handler: async (request) => Webhooks.update(request.ctx, request.params.id, request.body),
  })

  route({
    method: 'DELETE',
    url: '/webhooks/:id',
    auth: { action: 'delete', capability: MANAGE },
    tags: ['integrations'],
    summary: 'Удалить вебхук',
    schema: {
      params: z.object({ id: z.uuid() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await Webhooks.remove(request.ctx, request.params.id)
      return { ok: true }
    },
  })

  route({
    method: 'POST',
    url: '/webhooks/:id/secret',
    auth: { action: 'manage', capability: MANAGE },
    tags: ['integrations'],
    summary: 'Перевыпустить секрет подписи',
    schema: { params: z.object({ id: z.uuid() }), response: { 200: WebhookSecret } },
    handler: async (request) => ({
      secret: await Webhooks.rotateSecret(request.ctx, request.params.id),
    }),
  })

  route({
    method: 'GET',
    url: '/webhooks/:id/deliveries',
    auth: { action: 'view' },
    tags: ['integrations'],
    summary: 'Журнал доставок вебхука',
    schema: {
      params: z.object({ id: z.uuid() }),
      querystring: z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().optional(),
      }),
      response: { 200: WebhookDeliveryList },
    },
    handler: async (request) =>
      Webhooks.deliveries(request.params.id, {
        limit: request.query.limit,
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      }),
  })

  route({
    method: 'POST',
    url: '/webhooks/:id/deliveries/:deliveryId/retry',
    auth: { action: 'manage', capability: MANAGE },
    tags: ['integrations'],
    summary: 'Повторить доставку вручную',
    schema: {
      params: z.object({ id: z.uuid(), deliveryId: z.uuid() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await retryDelivery(request.params.id, request.params.deliveryId)
      return { ok: true }
    },
  })
}
