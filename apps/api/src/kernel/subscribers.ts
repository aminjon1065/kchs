import type { EventEnvelope } from '@kchs/contracts'
import { systemCtx } from '~/shared/context.js'
import { logger } from '~/shared/logger/index.js'
import { redis } from '~/shared/redis/index.js'
import { usersWithAccess } from './access/acl-service.js'
import { usersWhoCanView } from './access/explain.js'
import { invalidatePrincipalSet } from './access/principal-set.js'
import { activitySubscriber } from './activity/service.js'
import { COLLAB_CHANNEL, collabType } from './collab/registry.js'
import { registerSubscriber } from './events/bus.js'
import { invalidateCounts } from './inbox/service.js'
import { JobService } from './jobs/service.js'
import { NotificationService } from './notifications/service.js'
import { objectType } from './objects/registry.js'
import { processSubscribers } from './process/subscribers.js'
import { emitToRoom, revokeRoomAccess } from './realtime/gateway.js'
import { hasAccessDependents, indexObject, removeFromIndex } from './search/index-service.js'

/** Какое поле открытой вкладки устарело после события, не меняющего сам объект. */
const CHANGED_FIELD: Record<string, string> = {
  'object.tagged': 'tags',
  'file.previewed': 'preview',
  'file.text_extracted': 'text',
}

/** События, после которых меняются читатели всего поддерева объекта. */
const SUBTREE_EVENTS = new Set(['acl.changed', 'object.shared', 'object.moved'])

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
      // Вложение получает читателей объекта-хоста — и теряет их при откреплении
      if (
        (event.type === 'object.linked' || event.type === 'object.unlinked') &&
        event.payload.kind === 'attachment' &&
        typeof event.payload.targetId === 'string'
      ) {
        await indexObject(event.payload.targetId)
      }
      // Права потомков и вложений зависят от этого объекта: их фильтр
      // в индексе пересчитывается заданием, не задерживая шину
      if (SUBTREE_EVENTS.has(event.type) && (await hasAccessDependents(event.object.id))) {
        await JobService.enqueue(systemCtx('search.subtree'), {
          queue: 'index',
          name: 'search.reindex-subtree',
          data: { objectId: event.object.id },
          objectId: event.object.id,
          idempotencyKey: `search.reindex-subtree:${event.id}`,
        })
      }
    },
  })

  registerSubscriber({
    name: 'kernel-realtime',
    types: [
      'object.*',
      'message.*',
      'acl.changed',
      'inbox.*',
      'file.previewed',
      'file.text_extracted',
    ],
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
        case 'object.tagged':
        case 'file.previewed':
        case 'file.text_extracted':
          // Открытая вкладка перечитывает теги или превью без перезагрузки
          emitToRoom(`object:${event.object.id}`, 'object.updated', {
            id: event.object.id,
            type: event.object.type,
            version: 0,
            changedFields: [CHANGED_FIELD[event.type] ?? 'meta'],
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
        case 'message.edited':
        case 'message.deleted':
        case 'message.reacted': {
          // Правка, удаление и реакции — соседи перечитывают обсуждение
          const payload = {
            conversationId: event.payload.conversationId,
            messageId: event.payload.messageId,
            objectId: event.object.id,
          }
          emitToRoom(
            `conversation:${event.payload.conversationId as string}`,
            'message.updated',
            payload,
          )
          emitToRoom(`object:${event.object.id}`, 'message.updated', payload)
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

  // Совместные документы: подключения перепроверяются сразу, а не при очередной
  // минутной проверке, — права отозваны, объект в корзине или архиве (ADR-0070)
  registerSubscriber({
    name: 'kernel-collab',
    types: [
      'acl.changed',
      'object.shared',
      'object.moved',
      'object.archived',
      'object.restored',
      'object.trashed',
      'object.deleted',
    ],
    handle: async (event) => {
      if (!event.object || !collabType(event.object.type)) return
      await redis().publish(COLLAB_CHANNEL, JSON.stringify({ objectId: event.object.id }))
    },
  })

  // Счётчики Входящих — после коммита: в транзакции открытия и закрытия дела его ещё
  // не видно другим соединениям
  registerSubscriber({
    name: 'kernel-inbox-counts',
    types: ['inbox.opened', 'inbox.resolved'],
    handle: async (event) => {
      const alsoFor = Array.isArray(event.payload.alsoFor)
        ? (event.payload.alsoFor as string[])
        : []
      await invalidateCounts([event.payload.userId as string, ...alsoFor])
    },
  })

  // Задание попадает в BullMQ только после коммита транзакции, в которой его поставили
  registerSubscriber({
    name: 'kernel-jobs',
    types: ['job.queued'],
    handle: async (event) => {
      await JobService.dispatch(event.payload.jobId as string)
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
      'user.roles_changed',
    ],
    handle: async (event) => {
      const userId = (event.payload.userId ?? event.payload.toUserId) as string | undefined
      if (userId) await invalidatePrincipalSet(userId)
      const fromUserId = event.payload.fromUserId as string | undefined
      if (fromUserId) await invalidatePrincipalSet(fromUserId)
    },
  })

  // Движок процессов: уведомления, лента, ожидание событий, корзина объекта (ADR-0079)
  for (const subscriber of processSubscribers()) registerSubscriber(subscriber)

  logger().info('подписчики ядра зарегистрированы')
}

async function notificationHandler(event: EventEnvelope): Promise<void> {
  if (event.type === 'job.failed') {
    await notifyJobFailed(event)
    return
  }
  if (!event.object) return
  const url = objectType(event.object.type)?.route(event.object.id) ?? `/o/${event.object.id}`

  switch (event.type) {
    case 'mention.created': {
      // Упоминание не раскрывает объект: уведомляем только тех, кто его видит
      const userIds = await usersWhoCanView(
        event.object.id,
        (event.payload.userIds as string[] | undefined) ?? [],
      )
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
      // Права выданы как следствие другого действия — о нём сообщает свой модуль
      if (event.payload.quiet === true) break
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
    default:
      break
  }
}

/** Инициатор узнаёт, что его задание окончательно не выполнено. */
async function notifyJobFailed(event: EventEnvelope): Promise<void> {
  const initiatorId = event.actor.userId
  if (!initiatorId) return
  const job = await JobService.get(event.payload.jobId as string)
  if (!job) return
  const url = job.objectId ? `/o/${job.objectId}` : '/processes'
  await NotificationService.notify({
    userIds: [initiatorId],
    category: 'system',
    titleKey: 'notifications.tpl.jobFailed',
    params: { title: job.name },
    objectId: job.objectId,
    url,
  })
}
