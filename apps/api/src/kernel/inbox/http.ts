import { InboxCounts, InboxItem, InboxQuery } from '@kchs/contracts'
import { z } from 'zod'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { InboxService } from './service.js'

export function registerInboxRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/inbox',
    auth: 'session',
    tags: ['inbox'],
    summary: 'Входящие: что требует действия',
    schema: {
      querystring: InboxQuery,
      response: {
        200: z.object({ items: z.array(InboxItem), nextCursor: z.string().nullable() }),
      },
    },
    handler: async (request) => InboxService.list(request.ctx, request.query),
  })

  route({
    method: 'GET',
    url: '/inbox/counts',
    auth: 'session',
    tags: ['inbox'],
    summary: 'Счётчики Входящих',
    schema: { response: { 200: InboxCounts } },
    handler: async (request) => InboxService.counts(request.ctx.userId),
  })

  route({
    method: 'POST',
    url: '/inbox/:id/snooze',
    auth: 'session',
    tags: ['inbox'],
    summary: 'Отложить элемент Входящих',
    schema: {
      params: z.object({ id: z.uuid() }),
      body: z.object({ until: z.iso.datetime({ offset: true }) }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await InboxService.snooze(request.ctx, request.params.id, request.body.until)
      return { ok: true }
    },
  })
}
