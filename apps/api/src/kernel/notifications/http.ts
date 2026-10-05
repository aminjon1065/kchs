import type { RouteRegistrar } from '~/shared/http/route.js'
import { NotificationService } from './service.js'

export function registerNotificationRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /notifications',
    auth: 'session',
    tags: ['notifications'],
    summary: 'Центр уведомлений',
    handler: async (request) =>
      NotificationService.list(request.ctx.userId, {
        unreadOnly: request.query.unreadOnly,
        limit: request.query.limit,
        cursor: request.query.cursor,
      }),
  })

  route({
    route: 'POST /notifications/read',
    auth: 'session',
    tags: ['notifications'],
    summary: 'Отметить уведомления прочитанными',
    handler: async (request) => {
      if (request.body.all) await NotificationService.markAllRead(request.ctx.userId)
      else await NotificationService.markRead(request.ctx.userId, request.body.ids ?? [])
      return { unread: await NotificationService.unreadCount(request.ctx.userId) }
    },
  })

  route({
    route: 'GET /me/notification-preferences',
    auth: 'session',
    tags: ['notifications'],
    summary: 'Настройки уведомлений',
    handler: async (request) => NotificationService.preferences(request.ctx.userId),
  })

  route({
    route: 'PUT /me/notification-preferences',
    auth: 'session',
    tags: ['notifications'],
    summary: 'Изменить настройку уведомлений',
    handler: async (request) => {
      await NotificationService.setPreference(
        request.ctx.userId,
        request.body.category,
        request.body.channel,
        request.body.mode,
      )
      return { ok: true }
    },
  })
}
