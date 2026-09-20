import {
  Integration,
  IntegrationCheckResult,
  IntegrationCreateInput,
  IntegrationInboundSecret,
  IntegrationList,
  IntegrationSyncList,
  IntegrationUpdateInput,
} from '@kchs/contracts'
import { z } from 'zod'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { isBuiltinKey } from '../domain/builtins.js'
import { receiveInbound } from '../domain/inbound.js'
import { Integrations } from '../domain/integration-service.js'
import { MANAGE } from '../domain/object-types.js'

/** Интеграции установки (14-automation-integrations.md §5, ADR-0097). */
export function registerIntegrationRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/integrations',
    auth: { capability: MANAGE },
    tags: ['integrations'],
    summary: 'Интеграции установки: записи реестра и встроенные службы',
    schema: { response: { 200: IntegrationList } },
    handler: async () => ({ items: await Integrations.list() }),
  })

  route({
    method: 'POST',
    url: '/integrations',
    auth: { capability: MANAGE },
    tags: ['integrations'],
    summary: 'Завести интеграцию',
    schema: { body: IntegrationCreateInput, response: { 200: Integration } },
    handler: async (request) => Integrations.create(request.ctx, request.body),
  })

  route({
    method: 'GET',
    url: '/integrations/:id',
    auth: { action: 'view' },
    tags: ['integrations'],
    summary: 'Карточка интеграции (без значений секретов)',
    schema: { params: z.object({ id: z.uuid() }), response: { 200: Integration } },
    handler: async (request) => Integrations.get(request.params.id),
  })

  route({
    method: 'PATCH',
    url: '/integrations/:id',
    auth: { action: 'manage', capability: MANAGE },
    tags: ['integrations'],
    summary: 'Изменить интеграцию или её секреты',
    schema: {
      params: z.object({ id: z.uuid() }),
      body: IntegrationUpdateInput,
      response: { 200: Integration },
    },
    handler: async (request) => Integrations.update(request.ctx, request.params.id, request.body),
  })

  route({
    method: 'DELETE',
    url: '/integrations/:id',
    auth: { action: 'delete', capability: MANAGE },
    tags: ['integrations'],
    summary: 'Удалить интеграцию',
    schema: {
      params: z.object({ id: z.uuid() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await Integrations.remove(request.ctx, request.params.id)
      return { ok: true }
    },
  })

  route({
    method: 'POST',
    url: '/integrations/:id/check',
    auth: { action: 'check', capability: MANAGE },
    tags: ['integrations'],
    summary: 'Проверить соединение',
    schema: { params: z.object({ id: z.uuid() }), response: { 200: IntegrationCheckResult } },
    rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async (request) => Integrations.check(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/integrations/:id/inbound-secret',
    auth: { action: 'manage', capability: MANAGE },
    tags: ['integrations'],
    summary: 'Выпустить секрет входящего вебхука: адрес показывается один раз',
    schema: {
      params: z.object({ id: z.uuid() }),
      response: { 200: IntegrationInboundSecret },
    },
    handler: async (request) => Integrations.rotateInboundSecret(request.ctx, request.params.id),
  })

  route({
    method: 'GET',
    url: '/integrations/:id/syncs',
    auth: { action: 'view' },
    tags: ['integrations'],
    summary: 'Журнал синхронизаций интеграции',
    schema: {
      params: z.object({ id: z.uuid() }),
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      response: { 200: IntegrationSyncList },
    },
    handler: async (request) => ({
      items: await Integrations.syncs(request.params.id, request.query.limit),
    }),
  })

  route({
    method: 'POST',
    url: '/integrations/builtin/:key/check',
    auth: { capability: MANAGE },
    tags: ['integrations'],
    summary: 'Проверить соединение встроенной службы (SMTP, Telegram)',
    schema: {
      params: z.object({ key: z.string().max(40) }),
      response: { 200: IntegrationCheckResult },
    },
    rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async (request) => {
      if (!isBuiltinKey(request.params.key)) throw errors.notFound('Встроенная интеграция')
      return Integrations.checkBuiltin(request.ctx, request.params.key)
    },
  })

  route({
    method: 'POST',
    url: '/hooks/:integrationId/:secret',
    // Входящий вебхук проверяется секретом самой интеграции; доступа к данным
    // он не даёт — только публикует факт `webhook.received` (ADR-0097)
    auth: 'public',
    tags: ['integrations'],
    summary: 'Входящий вебхук интеграции',
    description:
      'Публикует событие `webhook.received`; его подхватывают правила автоматизации. ' +
      'Неизвестная интеграция, выключенный вход и неверный секрет отвечают одинаково — 404.',
    schema: {
      params: z.object({ integrationId: z.uuid(), secret: z.string().min(8).max(200) }),
      body: z.unknown(),
      response: { 202: z.object({ accepted: z.boolean() }) },
    },
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
