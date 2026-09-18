import { Notification, NotificationPreferences } from '@kchs/contracts'
import { z } from 'zod'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { NotificationService } from './service.js'

export function registerNotificationRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/notifications',
    auth: 'session',
    tags: ['notifications'],
    summary: 'Центр уведомлений',
    schema: {
      querystring: z.object({
        unreadOnly: z.coerce.boolean().default(false),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        cursor: z.string().optional(),
      }),
      response: {
        200: z.object({
          items: z.array(Notification),
          nextCursor: z.string().nullable(),
          unread: z.number().int(),
        }),
      },
    },
    handler: async (request) =>
      NotificationService.list(request.ctx.userId, {
        unreadOnly: request.query.unreadOnly,
        limit: request.query.limit,
        cursor: request.query.cursor,
      }),
  })

  route({
    method: 'POST',
    url: '/notifications/read',
    auth: 'session',
    tags: ['notifications'],
    summary: 'Отметить уведомления прочитанными',
    schema: {
      body: z.object({ ids: z.array(z.string()).optional(), all: z.boolean().default(false) }),
      response: { 200: z.object({ unread: z.number().int() }) },
    },
    handler: async (request) => {
      if (request.body.all) await NotificationService.markAllRead(request.ctx.userId)
      else await NotificationService.markRead(request.ctx.userId, request.body.ids ?? [])
      return { unread: await NotificationService.unreadCount(request.ctx.userId) }
    },
  })

  route({
    method: 'GET',
    url: '/me/notification-preferences',
    auth: 'session',
    tags: ['notifications'],
    summary: 'Настройки уведомлений',
    schema: { response: { 200: NotificationPreferences } },
    handler: async (request) => NotificationService.preferences(request.ctx.userId),
  })

  route({
    method: 'PUT',
    url: '/me/notification-preferences',
    auth: 'session',
    tags: ['notifications'],
    summary: 'Изменить настройку уведомлений',
    schema: {
      body: z.object({
        category: z.string(),
        channel: z.enum(['app', 'email', 'telegram', 'push']),
        mode: z.enum(['immediate', 'digest', 'off']),
      }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await NotificationService.setPreference(
        request.ctx.userId,
        request.body.category as never,
        request.body.channel,
        request.body.mode,
      )
      return { ok: true }
    },
  })
}
