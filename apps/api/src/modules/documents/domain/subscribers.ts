import type { EventEnvelope } from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { recordModuleActivity } from '~/kernel/activity/service.js'
import type { Subscriber } from '~/kernel/events/types.js'
import { InboxService } from '~/kernel/inbox/service.js'
import { NotificationService } from '~/kernel/notifications/service.js'
import { emitToRoom } from '~/kernel/realtime/gateway.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { documents } from '~/shared/db/schema/index.js'
import { refreshJournalViewers, refreshViewers } from './participants.js'

/** Лента документа (вкладка «История»): создание пишет ядро (`object.created`). */
const ACTIVITY: Record<string, { verb: string; key: string }> = {
  'document.registered': { verb: 'registered', key: 'activity.document.registered' },
  'document.cancelled': { verb: 'cancelled', key: 'activity.document.cancelled' },
  'document.status_changed': { verb: 'status_changed', key: 'activity.document.statusChanged' },
  'document.updated': { verb: 'updated', key: 'activity.document.updated' },
  'document.version_added': { verb: 'version_added', key: 'activity.document.versionAdded' },
  'document.confidentiality_changed': {
    verb: 'confidentiality_changed',
    key: 'activity.document.confidentialityChanged',
  },
}

async function activity(event: EventEnvelope): Promise<void> {
  const mapping = ACTIVITY[event.type]
  if (!mapping || !event.object) return
  // Регистрация и аннулирование пишут свои записи — переход статуса по ним не дублируем
  if (
    event.type === 'document.status_changed' &&
    (event.payload.cause === 'register' || event.payload.cause === 'cancel')
  ) {
    return
  }
  await recordModuleActivity(event, mapping)
}

async function participantsOf(documentId: string) {
  const [row] = await db()
    .select({
      responsibleId: documents.responsibleId,
      controllerId: documents.controllerId,
      authorId: documents.authorId,
      status: documents.status,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)
  return row ?? null
}

const people = (...ids: Array<string | null | undefined>): string[] =>
  ids.filter((id): id is string => typeof id === 'string')

/**
 * Уведомления категории `documents` (12-calendar-notifications-home.md §2):
 * ответственному и контролёру — о регистрации, новым участникам — о назначении.
 * Название документа с грифом от «конфиденциально» ядро заменяет на «Документ № …».
 */
async function notify(event: EventEnvelope): Promise<void> {
  if (!event.object) return
  const doc = await participantsOf(event.object.id)
  if (!doc) return
  const base = {
    category: 'documents' as const,
    objectId: event.object.id,
    actorId: event.actor.userId,
    url: `/o/${event.object.id}`,
    params: { title: event.object.title ?? '' },
  }
  switch (event.type) {
    case 'document.registered':
      await NotificationService.notify({
        ...base,
        userIds: people(doc.responsibleId, doc.controllerId),
        titleKey: 'notifications.tpl.documentRegistered',
        params: { ...base.params, number: String(event.payload.number ?? '') },
      })
      break
    case 'document.participants_changed': {
      // Черновик — ещё дело автора; назначения по нему придут при регистрации
      if (doc.status === 'draft') break
      const added = (event.payload.added as string[] | undefined) ?? []
      await NotificationService.notify({
        ...base,
        userIds: added,
        titleKey: 'notifications.tpl.documentAssigned',
      })
      break
    }
    case 'document.cancelled':
      await NotificationService.notify({
        ...base,
        userIds: people(doc.responsibleId, doc.controllerId, doc.authorId),
        titleKey: 'notifications.tpl.documentCancelled',
      })
      break
    default:
      break
  }
}

/** Открытые вкладки документа перечитывают карточку (ключи `['object', id, …]`). */
function refreshTabs(event: EventEnvelope): void {
  if (!event.object) return
  emitToRoom(`object:${event.object.id}`, 'object.updated', {
    id: event.object.id,
    type: 'document',
    version: 0,
    changedFields: ['document'],
    actorId: event.actor.userId,
  })
}

/**
 * Права документа изменились (выдача, гриф, перенос в журнал) — пересчёт
 * `viewers` системного датасета; права журнала — у всех его документов.
 */
async function refreshAccess(event: EventEnvelope): Promise<void> {
  if (!event.object) return
  if (event.object.type === 'document') {
    await refreshViewers(db(), event.object.id)
    return
  }
  if (event.object.type === 'journal') await refreshJournalViewers(db(), event.object.id)
}

/** Документ в корзине — его дела во Входящих больше не ждут действия. */
async function dismissTrashed(event: EventEnvelope): Promise<void> {
  if (event.object?.type !== 'document') return
  await InboxService.resolve(
    db(),
    systemCtx('documents.trashed'),
    { objectId: event.object.id },
    'dismissed',
  )
}

export const documentSubscribers: Subscriber[] = [
  {
    name: 'documents-notifications',
    types: ['document.registered', 'document.participants_changed', 'document.cancelled'],
    handle: notify,
  },
  { name: 'documents-activity', types: ['document.*'], handle: activity },
  {
    name: 'documents-realtime',
    types: ['document.*'],
    handle: async (event) => refreshTabs(event),
  },
  { name: 'documents-viewers', types: ['acl.changed', 'object.moved'], handle: refreshAccess },
  { name: 'documents-trash', types: ['object.trashed'], handle: dismissTrashed },
]
