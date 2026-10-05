import {
  type NotificationChannelAdapter,
  setNotificationChannel,
} from '~/kernel/notifications/channels.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { PushService, pushConfig } from './domain/push-service.js'

/**
 * Канал уведомлений «push» (Web Push, ADR-0094): доступен тем, у кого
 * подписано хотя бы одно устройство, пока на установке заданы ключи VAPID.
 */
const pushChannel: NotificationChannelAdapter = {
  async available(userIds) {
    if (!pushConfig() || userIds.length === 0) return new Set()
    return PushService.subscribed(userIds)
  },
  deliver: (messages) => PushService.deliver(messages),
}

/** Канал push для уведомлений ядра — во всех ролях процесса. */
export function registerPushChannel(): void {
  setNotificationChannel('push', pushChannel)
}

export function registerPushRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /me/push',
    auth: 'session',
    tags: ['integrations'],
    summary: 'Push: настроен ли на установке и сколько устройств подписано',
    handler: async (request) => {
      const push = pushConfig()
      return {
        enabled: push !== null,
        publicKey: push?.publicKey ?? null,
        devices: push ? await PushService.deviceCount(request.ctx.userId) : 0,
      }
    },
  })

  route({
    route: 'POST /me/push/subscriptions',
    auth: 'session',
    tags: ['integrations'],
    summary: 'Push: подписать это устройство',
    handler: async (request) => {
      if (!pushConfig()) throw errors.unavailable('Push не настроен на этой установке')
      return PushService.subscribe(request.ctx, request.body)
    },
  })

  route({
    route: 'DELETE /me/push/subscriptions',
    auth: 'session',
    tags: ['integrations'],
    summary: 'Push: отписать это устройство',
    handler: async (request) => ({
      ok: await PushService.unsubscribe(request.ctx, request.body.endpoint),
    }),
  })
}
