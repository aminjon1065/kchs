import type { EventEnvelope } from '@kchs/contracts'
import { logger } from '~/shared/logger/index.js'
import { usersWithAccess } from './access/acl-service.js'
import { invalidatePrincipalSet } from './access/principal-set.js'
import { activitySubscriber } from './activity/service.js'
import { registerSubscriber } from './events/bus.js'
import { NotificationService } from './notifications/service.js'
import { objectType } from './objects/registry.js'
import { emitToRoom, revokeRoomAccess } from './realtime/gateway.js'
import { indexObject, removeFromIndex } from './search/index-service.js'

/** Подписчики ядра: активность, поиск, realtime, уведомления. */
export function registerKernelSubscribers(): void {
  registerSubscriber(activitySubscriber)

  registerSubscriber({
    name: 'kernel-search',
    types: ['object.*', 'acl.changed', 'file.text_extracted'],
    handle: async (event) => {
      if (!event.object) return
      if (event.type === 'object.deleted' || event.type === 'object.trashed') {
        await removeFromIndex(event.object.id)
        return
      }
      await indexObject(event.object.id)
    },
  })

  registerSubscriber({
    name: 'kernel-realtime',
    types: ['object.*', 'message.*', 'acl.changed', 'inbox.*'],
    handle: async (event) => {
      if (!event.object) return
      switch (event.type) {
        case 'object.updated':
        case 'object.moved':
        case 'object.archived':
        case 'object.restored':
          emitToRoom(`object:${event.object.id}`, 'object.updated', {
            id: event.object.id,
            type: event.object.type,
            version: 0,
            changedFields: event.changedFields,
            actorId: event.actor.userId,
          })
          break
        case 'object.trashed':
        case 'object.deleted':
          emitToRoom(`object:${event.object.id}`, 'object.removed', { id: event.object.id })
          break
        case 'message.posted': {
          const payload = {
            conversationId: event.payload.conversationId,
            messageId: event.payload.messageId,
            objectId: event.object.id,
          }
          emitToRoom(
            `conversation:${event.payload.conversationId as string}`,
            'message.posted',
            payload,
          )
          // Открытая вкладка объекта обновляет обсуждение и ленту активности
          emitToRoom(`object:${event.object.id}`, 'message.posted', payload)
          break
        }
        case 'acl.changed':
          await revokeRoomAccess(event.object.id)
          break
        default:
          break
      }
    },
  })

  registerSubscriber({
    name: 'kernel-notifications',
    types: ['message.posted', 'mention.created', 'object.shared', 'job.failed'],
    handle: notificationHandler,
  })

  registerSubscriber({
    name: 'kernel-principals',
    types: [
      'space.member_added',
      'space.member_removed',
      'space.member_role_changed',
      'org.employment_changed',
      'delegation.started',
      'delegation.ended',
      'role.assigned',
    ],
    handle: async (event) => {
      const userId = (event.payload.userId ?? event.payload.toUserId) as string | undefined
      if (userId) await invalidatePrincipalSet(userId)
      const fromUserId = event.payload.fromUserId as string | undefined
      if (fromUserId) await invalidatePrincipalSet(fromUserId)
    },
  })

  logger().info('подписчики ядра зарегистрированы')
}

async function notificationHandler(event: EventEnvelope): Promise<void> {
  if (!event.object) return
  const url = objectType(event.object.type)?.route(event.object.id) ?? `/o/${event.object.id}`

  switch (event.type) {
    case 'mention.created': {
      const userIds = (event.payload.userIds as string[] | undefined) ?? []
      await NotificationService.notify({
        userIds,
        category: 'mention',
        titleKey: 'notifications.tpl.mention',
        params: { title: event.object.title ?? '' },
        objectId: event.object.id,
        actorId: event.actor.userId,
        url,
      })
      break
    }
    case 'message.posted': {
      // Уведомляем подписчиков объекта, кроме упомянутых (им придёт mention)
      const mentioned = new Set((event.payload.mentions as string[] | undefined) ?? [])
      const recipients = (await usersWithAccess(event.object.id, 'view')).filter(
        (id) => !mentioned.has(id),
      )
      await NotificationService.notify({
        userIds: recipients,
        category: 'discussion',
        titleKey: 'notifications.tpl.messagePosted',
        params: { title: event.object.title ?? '' },
        objectId: event.object.id,
        actorId: event.actor.userId,
        url,
      })
      break
    }
    case 'object.shared': {
      const added = (event.payload.added as Array<{ principal: string }> | undefined) ?? []
      const userIds = added
        .filter((a) => a.principal.startsWith('user:'))
        .map((a) => a.principal.slice('user:'.length))
      await NotificationService.notify({
        userIds,
        category: 'object',
        titleKey: 'notifications.tpl.objectShared',
        params: { title: event.object.title ?? '' },
        objectId: event.object.id,
        actorId: event.actor.userId,
        url,
      })
      break
    }
    case 'job.failed': {
      if (!event.actor.userId) break
      await NotificationService.notify({
        userIds: [event.actor.userId],
        category: 'system',
        titleKey: 'notifications.tpl.jobFailed',
        params: { title: event.object.title ?? '' },
        objectId: null,
        url: null,
      })
      break
    }
    default:
      break
  }
}
