import type { EventEnvelope } from '@kchs/contracts'
import { loadObject } from '~/kernel/access/authorize.js'
import type { Subscriber } from '~/kernel/events/types.js'
import { NotificationService } from '~/kernel/notifications/service.js'

/**
 * Уведомления о правках модерируемого слоя (ADR-0076): владельцу слоя — о новой
 * правке на проверку (дело во Входящих открывает сама подача), автору — о
 * решении. Себе о своём действии — нет (правило NotificationService).
 */
async function notify(event: EventEnvelope): Promise<void> {
  if (!event.object) return
  const base = {
    category: 'data' as const,
    objectId: event.object.id,
    actorId: event.actor.userId,
    url: `/o/${event.object.id}`,
    params: { title: event.object.title ?? '' },
  }
  if (event.type === 'feature.edit_submitted') {
    const layer = await loadObject(event.object.id)
    if (!layer?.ownerId) return
    await NotificationService.notify({
      ...base,
      userIds: [layer.ownerId],
      titleKey: 'notifications.tpl.featureEditSubmitted',
    })
    return
  }
  const authorId = event.payload.authorId
  if (event.type !== 'feature.edit_reviewed' || typeof authorId !== 'string') return
  await NotificationService.notify({
    ...base,
    userIds: [authorId],
    titleKey:
      event.payload.decision === 'approved'
        ? 'notifications.tpl.featureEditApproved'
        : 'notifications.tpl.featureEditRejected',
  })
}

export const featureSubscribers: Subscriber[] = [
  {
    name: 'gis-feature-notifications',
    types: ['feature.edit_submitted', 'feature.edit_reviewed'],
    handle: notify,
  },
]
