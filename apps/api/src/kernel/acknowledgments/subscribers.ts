import type { EventEnvelope } from '@kchs/contracts'
import type { Subscriber } from '../events/types.js'
import { NotificationService } from '../notifications/service.js'
import { emitToRoom } from '../realtime/gateway.js'

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/**
 * Уведомления об ознакомлении (категория `inbox` — действие): запрос из
 * карточки и правилом типа — получателям; о шаге маршрута уведомляет движок.
 * Напоминание — тем, кто не ознакомился.
 */
async function notify(event: EventEnvelope): Promise<void> {
  if (!event.object) return
  const base = {
    category: 'inbox' as const,
    objectId: event.object.id,
    url: `/o/${event.object.id}`,
    params: { title: event.object.title ?? '' },
  }
  if (event.type === 'acknowledgment.requested') {
    if (event.payload.source === 'process') return
    await NotificationService.notify({
      ...base,
      userIds: ids(event.payload.userIds),
      actorId: event.actor.userId,
      titleKey: 'notifications.tpl.acknowledgmentRequested',
      aggregateKey: `ack:${String(event.payload.requestId)}`,
    })
    return
  }
  if (event.type === 'acknowledgment.reminded') {
    await NotificationService.notify({
      ...base,
      userIds: ids(event.payload.userIds),
      actorId: event.payload.auto ? null : event.actor.userId,
      titleKey: 'notifications.tpl.acknowledgmentReminder',
      aggregateKey: `ack-remind:${event.object.id}:${new Date().toISOString().slice(0, 10)}`,
    })
  }
}

/** Открытая вкладка объекта перечитывает ознакомление. */
function refresh(event: EventEnvelope): void {
  if (!event.object) return
  emitToRoom(`object:${event.object.id}`, 'object.updated', {
    id: event.object.id,
    type: event.object.type,
    version: 0,
    changedFields: ['acknowledgments'],
    actorId: event.actor.userId,
  })
}

export const acknowledgmentSubscribers: Subscriber[] = [
  {
    name: 'kernel-acknowledgments-notifications',
    types: ['acknowledgment.requested', 'acknowledgment.reminded'],
    handle: notify,
  },
  {
    name: 'kernel-acknowledgments-realtime',
    types: ['acknowledgment.*'],
    handle: async (event) => refresh(event),
  },
]
