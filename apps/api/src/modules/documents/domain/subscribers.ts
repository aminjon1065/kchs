import { type DocumentStatus, type EventEnvelope, isDocumentClosed } from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { recordModuleActivity } from '~/kernel/activity/service.js'
import type { Subscriber } from '~/kernel/events/types.js'
import { InboxService } from '~/kernel/inbox/service.js'
import { NotificationService } from '~/kernel/notifications/service.js'
import { emitToRoom } from '~/kernel/realtime/gateway.js'
import { indexObject } from '~/kernel/search/index-service.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { documents } from '~/shared/db/schema/index.js'
import { MailIntake } from './mail/mail-service.js'
import { refreshJournalViewers, refreshViewers } from './participants.js'
import { prepareReplyReports } from './reply-report.js'
import { ResolutionService } from './resolution-service.js'

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
  'document.resolution_requested': {
    verb: 'resolution_requested',
    key: 'activity.document.resolutionRequested',
  },
  'document.resolution_added': {
    verb: 'resolution_added',
    key: 'activity.document.resolutionAdded',
  },
  // Дела и переписка (ADR-0086)
  'document.filed': { verb: 'filed', key: 'activity.document.filed' },
  'document.dispatched': { verb: 'dispatched', key: 'activity.document.dispatched' },
  'document.files_destroyed': {
    verb: 'files_destroyed',
    key: 'activity.document.filesDestroyed',
  },
  'case.created': { verb: 'created', key: 'activity.case.created' },
  'case.updated': { verb: 'updated', key: 'activity.case.updated' },
  'case.closed': { verb: 'closed', key: 'activity.case.closed' },
  'case.reopened': { verb: 'reopened', key: 'activity.case.reopened' },
  'case.archived': { verb: 'archived', key: 'activity.case.archived' },
  'case.destroyed': { verb: 'destroyed', key: 'activity.case.destroyed' },
}

/** Переходы, у которых своя запись ленты: регистрация, аннулирование, подшивка, отправка. */
const OWN_ENTRY_CAUSES = new Set(['register', 'cancel', 'filing', 'dispatch'])

async function activity(event: EventEnvelope): Promise<void> {
  const mapping = ACTIVITY[event.type]
  if (!mapping || !event.object) return
  if (
    event.type === 'document.status_changed' &&
    OWN_ENTRY_CAUSES.has(String(event.payload.cause))
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
      // Черновик — ещё дело автора; назначения по нему придут при регистрации.
      // Участники резолюций, направлений и ознакомления узнают о своём деле из
      // Входящих и поручений — здесь только реквизиты карточки (ADR-0084)
      if (doc.status === 'draft' || event.payload.source !== 'card') break
      const added = (event.payload.added as string[] | undefined) ?? []
      await NotificationService.notify({
        ...base,
        userIds: added,
        titleKey: 'notifications.tpl.documentAssigned',
      })
      break
    }
    // Письмо исходящего не ушло или вернулось (ADR-0149): узнаёт тот, кто его ставил
    case 'document.email_failed':
      if (typeof event.payload.createdBy !== 'string') break
      await NotificationService.notify({
        ...base,
        actorId: null,
        userIds: [event.payload.createdBy],
        titleKey:
          event.payload.reason === 'bounced'
            ? 'notifications.tpl.documentEmailBounced'
            : 'notifications.tpl.documentEmailFailed',
        params: {
          ...base.params,
          to: String(event.payload.to ?? ''),
          error: String(event.payload.error ?? ''),
        },
      })
      break
    case 'document.cancelled':
      await NotificationService.notify({
        ...base,
        userIds: people(doc.responsibleId, doc.controllerId, doc.authorId),
        titleKey: 'notifications.tpl.documentCancelled',
      })
      break
    // Направление на резолюцию — действие: категория Входящих, в Telegram сразу
    case 'document.resolution_requested':
      await NotificationService.notify({
        ...base,
        category: 'inbox',
        userIds: people(event.payload.userId as string | undefined),
        titleKey: 'notifications.tpl.resolutionRequested',
        aggregateKey: `resolve:${event.object.id}`,
      })
      break
    default:
      break
  }
}

/**
 * Открытые вкладки документа и дела перечитывают карточку (ключи
 * `['object', id, …]`); связь «в ответ на» — вкладку второго документа тоже.
 */
function refreshTabs(event: EventEnvelope): void {
  if (!event.object) return
  const notify = (id: string, type: string) =>
    emitToRoom(`object:${id}`, 'object.updated', {
      id,
      type,
      version: 0,
      changedFields: [type],
      actorId: event.actor.userId,
    })
  if (event.type === 'object.linked' || event.type === 'object.unlinked') {
    if (event.object.type !== 'document' || event.payload.kind !== 'reply_to') return
    notify(event.object.id, 'document')
    if (typeof event.payload.targetId === 'string') notify(event.payload.targetId, 'document')
    return
  }
  notify(event.object.id, event.object.type === 'case' ? 'case' : 'document')
  // Подшивка меняет число документов дела — вкладка дела тоже перечитывается
  if (event.type === 'document.filed' && typeof event.payload.caseId === 'string') {
    notify(event.payload.caseId, 'case')
  }
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

/**
 * Исполнение (08-documents.md §6, ADR-0084): последнее поручение документа
 * принято или отменено — документ на исполнении становится «Исполнен».
 */
async function executed(event: EventEnvelope): Promise<void> {
  if (event.object?.type !== 'document') return
  const documentId = event.object.id
  const resolutionIds = Array.isArray(event.payload.resolutionIds)
    ? (event.payload.resolutionIds as string[])
    : []
  await db().transaction((tx) =>
    ResolutionService.executed(tx, systemCtx('documents.execution'), documentId, resolutionIds),
  )
}

/**
 * Документ аннулирован или закрыт другим путём (исполнен без решения
 * получателя, подшит «не требует исполнения», передан в архив) — открытые
 * направления на резолюцию снимаются.
 */
async function closed(event: EventEnvelope): Promise<void> {
  if (!event.object) return
  if (
    event.type === 'document.status_changed' &&
    !isDocumentClosed(event.payload.to as DocumentStatus)
  ) {
    return
  }
  const documentId = event.object.id
  await db().transaction((tx) =>
    ResolutionService.documentClosed(tx, systemCtx('documents.closed'), documentId),
  )
}

/**
 * Статус, номер, реквизиты и дело документа — в поисковом документе (фильтр
 * «Поиск в архиве» по `meta.status`, ADR-0086), как и состояние дела, а сводку
 * реестра модуль пишет «тихо»: индекс обновляют события модуля, иначе статус
 * в поиске устаревал бы.
 */
async function reindex(event: EventEnvelope): Promise<void> {
  if (event.object?.type !== 'document' && event.object?.type !== 'case') return
  await indexObject(event.object.id)
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

/** Черновик из письма зарегистрирован: письмо больше не ждёт решения. */
async function mailRegistered(event: EventEnvelope): Promise<void> {
  const documentId = event.object?.id
  if (!documentId) return
  await db().transaction((tx) => MailIntake.markRegistered(tx, documentId))
}

export const documentSubscribers: Subscriber[] = [
  {
    name: 'documents-notifications',
    types: [
      'document.registered',
      'document.participants_changed',
      'document.cancelled',
      'document.resolution_requested',
      'document.email_failed',
    ],
    handle: notify,
  },
  { name: 'documents-execution', types: ['task.source_closed'], handle: executed },
  {
    // Ответ отправлен — исполнителю поручения готовый отчёт (N22, ADR-0136)
    name: 'documents-reply-report',
    types: ['document.dispatched'],
    handle: async (event) => {
      await prepareReplyReports(event)
    },
  },
  {
    name: 'documents-resolution-requests',
    types: ['document.cancelled', 'document.status_changed'],
    handle: closed,
  },
  { name: 'documents-activity', types: ['document.*', 'case.*'], handle: activity },
  {
    name: 'documents-realtime',
    types: ['document.*', 'case.*', 'object.linked', 'object.unlinked'],
    handle: async (event) => refreshTabs(event),
  },
  { name: 'documents-viewers', types: ['acl.changed', 'object.moved'], handle: refreshAccess },
  { name: 'documents-trash', types: ['object.trashed'], handle: dismissTrashed },
  // Очередь «Из почты» (ADR-0113): письмо уходит из неё, когда его черновик
  // зарегистрирован — очередь узнаёт об этом из события, а не опросом
  { name: 'documents-mail-queue', types: ['document.registered'], handle: mailRegistered },
  {
    name: 'documents-search',
    types: [
      'document.status_changed',
      'document.registered',
      'document.updated',
      'document.filed',
      'document.dispatched',
      'document.files_destroyed',
      'case.updated',
      'case.closed',
      'case.reopened',
      'case.archived',
      'case.destroyed',
    ],
    handle: reindex,
  },
]
