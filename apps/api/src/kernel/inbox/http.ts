import type { RouteRegistrar } from '~/shared/http/route.js'
import { InboxService } from './service.js'

export function registerInboxRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /inbox',
    auth: 'session',
    tags: ['inbox'],
    summary: 'Входящие: что требует действия',
    handler: async (request) => InboxService.list(request.ctx, request.query),
  })

  route({
    route: 'GET /inbox/counts',
    auth: 'session',
    tags: ['inbox'],
    summary: 'Счётчики Входящих',
    handler: async (request) => InboxService.counts(request.ctx.userId),
  })

  route({
    route: 'POST /inbox/:id/act',
    auth: { owned: 'InboxService.act — только элементы «Входящих» вошедшего и замещаемых им' },
    tags: ['inbox'],
    summary: 'Выполнить действие элемента Входящих (принять, отчитаться, вернуть…)',
    handler: async (request) => {
      await InboxService.act(request.ctx, request.params.id, request.body)
      return { ok: true }
    },
  })

  route({
    route: 'POST /inbox/bulk',
    auth: 'session',
    tags: ['inbox'],
    summary: 'Массовое действие над выбранными делами: ознакомлен, выполнено, отложить',
    handler: async (request) => InboxService.bulk(request.ctx, request.body),
  })

  route({
    route: 'POST /inbox/:id/snooze',
    auth: { owned: 'InboxService.snooze — только свои элементы «Входящих»' },
    tags: ['inbox'],
    summary: 'Отложить элемент Входящих',
    handler: async (request) => {
      await InboxService.snooze(request.ctx, request.params.id, request.body.until)
      return { ok: true }
    },
  })
}
