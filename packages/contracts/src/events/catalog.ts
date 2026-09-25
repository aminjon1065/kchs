import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'

/**
 * Каталог доменных событий (16-api-and-events.md §2).
 * Регистрация типа события без схемы полезной нагрузки запрещена — проверяется тестом.
 * Здесь — события, появляющиеся в фазе 0; модули расширяют каталог своими схемами.
 */
const empty = z.object({})

/** Строка датасета в событиях строк (ADR-0133). */
const DatasetRowEvent = z.object({
  rowId: z.string(),
  values: z.record(z.string(), z.unknown()),
  labels: z.record(z.string(), z.string()).default({}),
  territories: z
    .record(
      z.string(),
      z.object({ id: Uuid, code: z.string(), name: z.string(), path: z.array(z.string()) }),
    )
    .default({}),
})

export const EVENT_PAYLOADS = {
  // ── object ────────────────────────────────────────────────────────────────
  'object.created': z.object({ type: z.string(), title: z.string() }),
  'object.updated': z.object({ title: z.string().optional() }),
  'object.moved': z.object({
    fromParentId: Uuid.nullable(),
    toParentId: Uuid.nullable(),
    fromSpaceId: Uuid.nullable(),
    toSpaceId: Uuid.nullable(),
  }),
  'object.archived': empty,
  'object.restored': z.object({ from: z.enum(['archive', 'trash']) }),
  'object.trashed': empty,
  'object.deleted': z.object({ type: z.string() }),
  'object.shared': z.object({
    added: z.array(z.object({ principal: z.string(), level: z.string() })).default([]),
    removed: z.array(z.object({ principal: z.string() })).default([]),
    changed: z.array(z.object({ principal: z.string(), level: z.string() })).default([]),
    accessMode: z.string().optional(),
    /** Права — следствие другого действия (участник поручения): без уведомления. */
    quiet: z.boolean().optional(),
  }),
  'object.linked': z.object({ kind: z.string(), targetId: Uuid }),
  'object.unlinked': z.object({ kind: z.string(), targetId: Uuid }),
  'object.tagged': z.object({ tagIds: z.array(Uuid) }),

  // ── identity ──────────────────────────────────────────────────────────────
  'user.created': z.object({
    login: z.string(),
    /** Служебная учётная запись (ADR-0130) создаётся тем же событием. */
    kind: z.enum(['person', 'service']).default('person'),
  }),
  'user.updated': empty,
  'user.blocked': z.object({ reason: z.string().nullable().default(null) }),
  'user.login': z.object({ ip: z.string().nullable(), userAgent: z.string().nullable() }),
  'user.login_failed': z.object({ login: z.string(), reason: z.string() }),
  'user.logout': empty,
  'user.password_changed': empty,
  'user.mfa_enabled': z.object({ kind: z.string() }),
  'user.mfa_disabled': z.object({ kind: z.string() }),
  'user.roles_changed': z.object({ userId: Uuid, roles: z.array(z.string()) }),
  /** Своя роль организации заведена, изменена или удалена (ADR-0165). */
  'role.created': z.object({ roleId: Uuid, key: z.string(), capabilities: z.array(z.string()) }),
  'role.updated': z.object({ roleId: Uuid, key: z.string(), capabilities: z.array(z.string()) }),
  'role.deleted': z.object({ roleId: Uuid, key: z.string() }),
  /** Допуск к грифам изменён администратором системы (ADR-0080). */
  'user.clearance_changed': z.object({ userId: Uuid, from: z.string(), to: z.string() }),
  /** Telegram привязан к пользователю (ADR-0061); chat_id в событие не попадает. */
  'user.telegram_linked': z.object({ userId: Uuid }),
  /** Привязка снята: самим пользователем или потому что бот заблокирован. */
  'user.telegram_unlinked': z.object({ userId: Uuid, reason: z.enum(['user', 'blocked']) }),
  /** Ключ входа (passkey) добавлен или отозван (ADR-0098); сам ключ в событие не попадает. */
  'user.passkey_added': z.object({ userId: Uuid, name: z.string() }),
  'user.passkey_removed': z.object({ userId: Uuid, name: z.string() }),
  /** Учётная запись связана с внешним поставщиком входа (OIDC или каталог). */
  'user.identity_linked': z.object({ userId: Uuid, provider: z.string() }),
  'org.unit_changed': z.object({ unitId: Uuid, change: z.string() }),
  'org.employment_changed': z.object({ userId: Uuid, unitId: Uuid.nullable() }),
  'delegation.started': z.object({ fromUserId: Uuid, toUserId: Uuid, scope: z.string() }),
  'delegation.ended': z.object({ fromUserId: Uuid, toUserId: Uuid }),
  'session.revoked': z.object({ sessionIds: z.array(Uuid) }),

  // ── space ─────────────────────────────────────────────────────────────────
  'space.created': z.object({ key: z.string(), kind: z.string() }),
  'space.member_added': z.object({ userId: Uuid, role: z.string() }),
  'space.member_removed': z.object({ userId: Uuid }),
  'space.member_role_changed': z.object({ userId: Uuid, role: z.string(), from: z.string() }),

  // ── discussion ────────────────────────────────────────────────────────────
  'message.posted': z.object({
    conversationId: Uuid,
    messageId: z.string(),
    preview: z.string(),
    threadRootId: z.string().nullable().default(null),
    mentions: z.array(Uuid).default([]),
  }),
  'message.edited': z.object({ conversationId: Uuid, messageId: z.string() }),
  'message.deleted': z.object({ conversationId: Uuid, messageId: z.string() }),
  'message.reacted': z.object({ conversationId: Uuid, messageId: z.string(), emoji: z.string() }),
  'mention.created': z.object({
    conversationId: Uuid,
    messageId: z.string(),
    userIds: z.array(Uuid),
  }),

  // ── chat (11-communications-meetings.md §1, ADR-0090) ─────────────────────
  // Объект событий чата — беседа; сообщения остаются домену `discussion`
  'chat.created': z.object({
    kind: z.string(),
    privacy: z.string(),
    memberIds: z.array(Uuid).default([]),
  }),
  'chat.renamed': z.object({ title: z.string(), from: z.string() }),
  /** Вступили сами (открытый канал) или добавил владелец: `invitedBy`. */
  'chat.member_joined': z.object({
    userIds: z.array(Uuid),
    invitedBy: Uuid.nullable().default(null),
  }),
  'chat.member_left': z.object({ userIds: z.array(Uuid), removed: z.boolean().default(false) }),
  'chat.message_pinned': z.object({ messageId: z.string(), preview: z.string() }),
  'chat.message_unpinned': z.object({ messageId: z.string() }),
  /** Сообщения пересланы в другие беседы: `targetIds` — куда. */
  'chat.messages_forwarded': z.object({
    messageIds: z.array(z.string()),
    targetIds: z.array(Uuid),
  }),
  /** Статус присутствия изменён — объекта у события нет. */
  'chat.presence_changed': z.object({
    userId: Uuid,
    status: z.string(),
    from: z.string(),
  }),

  // ── files ─────────────────────────────────────────────────────────────────
  'file.uploaded': z.object({ name: z.string(), size: z.number(), mime: z.string() }),
  'file.version_added': z.object({ versionId: Uuid, number: z.number().int() }),
  'file.text_extracted': z.object({ chars: z.number().int() }),
  'file.previewed': z.object({ status: z.string() }),
  'file.shared_link_created': z.object({ linkId: Uuid }),
  'file.downloaded': z.object({ versionId: Uuid.nullable() }),

  // ── notifications ─────────────────────────────────────────────────────────
  'notification.sent': z.object({
    userId: Uuid,
    category: z.string(),
    channels: z.array(z.string()),
  }),
  /** `alsoFor` — заместители, получившие копию дела. */
  'inbox.opened': z.object({
    userId: Uuid,
    kind: z.string(),
    itemId: Uuid,
    alsoFor: z.array(Uuid).optional(),
  }),
  'inbox.resolved': z.object({ userId: Uuid, itemId: Uuid, outcome: z.string() }),
  'inbox.snoozed': z.object({ userId: Uuid, itemId: Uuid, until: z.string() }),

  // ── jobs ──────────────────────────────────────────────────────────────────
  'job.queued': z.object({ jobId: Uuid, queue: z.string(), name: z.string() }),
  'job.started': z.object({ jobId: Uuid }),
  'job.finished': z.object({ jobId: Uuid, durationMs: z.number().int() }),
  'job.failed': z.object({ jobId: Uuid, error: z.string() }),

  // ── dataset (06-analytics-engine.md) ──────────────────────────────────────
  'dataset.created': z.object({ name: z.string(), fields: z.number().int() }),
  'dataset.schema_changed': z.object({
    change: z.enum(['added', 'updated', 'removed', 'type_changed']),
    fields: z.array(z.string()),
  }),
  'dataset.import_started': z.object({ importId: Uuid, mode: z.string() }),
  'dataset.imported': z.object({
    importId: Uuid,
    version: z.number().int(),
    mode: z.string(),
    rows: z.number().int(),
    inserted: z.number().int(),
    updated: z.number().int(),
    deleted: z.number().int(),
    errors: z.number().int(),
  }),
  'dataset.import_failed': z.object({ importId: Uuid, reason: z.string() }),
  /** Сводка изменений готова, импорт ждёт публикации (ADR-0068). */
  'dataset.import_review': z.object({
    importId: Uuid,
    added: z.number().int(),
    changed: z.number().int(),
    deleted: z.number().int(),
  }),
  'dataset.import_published': z.object({ importId: Uuid }),
  'dataset.import_cancelled': z.object({ importId: Uuid }),
  'dataset.rows_changed': z.object({
    op: z.enum(['insert', 'update', 'delete']),
    ids: z.array(z.string()).max(1000),
    count: z.number().int(),
  }),
  /**
   * Строка датасета с включёнными событиями строк (ADR-0133): значения полей без
   * чувствительных, подписи вариантов и территорий, территории с кодом и путём кодами
   * от страны — правило отбирает строки по значениям. Правка больше 200 строк за раз
   * публикует только `dataset.rows_changed`.
   */
  'dataset.row_created': DatasetRowEvent,
  /** Правка строки: полные значения после неё, изменённые поля и их прежние значения. */
  'dataset.row_updated': DatasetRowEvent.extend({
    changed: z.array(z.string()),
    previous: z.record(z.string(), z.unknown()),
  }),
  'dataset.row_deleted': DatasetRowEvent,
  'dataset.version_created': z.object({ version: z.number().int(), origin: z.string() }),
  /** Правила качества датасета изменены (ADR-0101). */
  'dataset.quality_rules_changed': z.object({ rules: z.number().int() }),
  /** Проверка качества прошла: статус версии и сколько правил не выполнилось. */
  'dataset.quality_checked': z.object({
    version: z.number().int(),
    status: z.enum(['unknown', 'ok', 'warning', 'failed']),
    failed: z.number().int(),
  }),
  /** Сборка колоночной копии поставлена (ADR-0109). */
  'dataset.columnar_build_started': z.object({ version: z.number().int() }),
  /** Колоночная копия собрана: версия данных и число строк в копии. */
  'dataset.columnar_built': z.object({ version: z.number().int(), rows: z.number().int() }),
  'dataset.rolled_back': z.object({
    version: z.number().int(),
    target: z.number().int(),
    from: z.number().int(),
  }),
  'dataset.policies_changed': z.object({
    kind: z.enum(['rows', 'columns']),
    op: z.enum(['created', 'updated', 'deleted']),
    policyId: Uuid,
  }),
  'chart.updated': z.object({ changed: z.array(z.string()) }),
  'dashboard.updated': z.object({ changed: z.array(z.string()) }),
  'metric.updated': z.object({ changed: z.array(z.string()) }),
  /** Снимок тетради после совместной правки (ADR-0070): что изменилось — ячейки, параметры. */
  'notebook.updated': z.object({ changed: z.array(z.enum(['cells', 'params'])) }),

  // ── база знаний (13-search-knowledge-ai.md §2, ADR-0095) ───────────────────
  /** Снимок страницы после совместной правки: блоки изменились. */
  'page.updated': z.object({ changed: z.array(z.enum(['blocks'])) }),
  /** Страница опубликована: снимок стал версией, срок пересмотра назначен. */
  'page.published': z.object({
    versionId: Uuid,
    number: z.number().int(),
    reviewAt: z.string().nullable(),
  }),
  /**
   * Состояние страницы изменилось. `cause`: `publish` — публикация,
   * `review_due` — наступил срок пересмотра, `manual` — владелец вернул в работу.
   */
  'page.status_changed': z.object({
    from: z.string(),
    to: z.string(),
    cause: z.enum(['publish', 'review_due', 'manual']),
  }),
  /** Снимок страницы сохранён версией: публикация, кнопка «Сохранить версию», откат. */
  'page.version_created': z.object({
    versionId: Uuid,
    number: z.number().int(),
    reason: z.enum(['publish', 'manual', 'restore']),
  }),
  /** Страница откачена к версии: её текст стал текущим (перед откатом снят снимок). */
  'page.restored': z.object({ versionId: Uuid, number: z.number().int() }),
  /** Срок пересмотра наступил: страница ушла на пересмотр, владельцу — дело. */
  'page.review_due': z.object({ reviewAt: z.string(), ownerId: Uuid.nullable() }),

  // ── reports (06-analytics-engine.md §12, ADR-0078) ─────────────────────────
  /** Снимок шаблона после совместной правки: блоки, параметры, настройки печати. */
  'report.updated': z.object({ changed: z.array(z.enum(['blocks', 'params', 'settings'])) }),
  /** Запуск рендера поставлен: «Сформировать» или расписание (по запуску на получателя). */
  'report.run_queued': z.object({
    runId: Uuid,
    trigger: z.enum(['manual', 'schedule']),
    runAs: Uuid,
  }),
  /** Движок открыл страницу печати: запуск идёт. */
  'report.run_started': z.object({ runId: Uuid, attempt: z.number().int() }),
  /** Файлы отчёта готовы в бакете экспортов. */
  'report.generated': z.object({
    runId: Uuid,
    trigger: z.enum(['manual', 'schedule']),
    runAs: Uuid,
    formats: z.array(z.string()),
    pages: z.number().int().nullable(),
    size: z.number().int(),
  }),
  /** Рендер не выполнен; skipped — получатель потерял доступ к отчёту. */
  'report.run_failed': z.object({
    runId: Uuid,
    trigger: z.enum(['manual', 'schedule']),
    runAs: Uuid,
    error: z.string(),
    skipped: z.boolean(),
  }),
  /** Расписание рассылки задано, изменено или снято (enabled: false, frequency: null). */
  'report.schedule_changed': z.object({
    enabled: z.boolean(),
    frequency: z.string().nullable(),
    recipients: z.number().int(),
  }),
  /** Отчёт доставлен получателю: итог по каналам (sent, unavailable, failed). */
  'report.delivered': z.object({
    runId: Uuid,
    userId: Uuid,
    channels: z.record(z.string(), z.string()),
  }),

  // ── gis: базовые карты (07-gis-engine.md §5, ADR-0066) ─────────────────────
  /** Изменились параметры подложки: адрес, ключ, масштабы, сборка (новая версия PMTiles). */
  'basemap.updated': z.object({ changed: z.array(z.string()) }),
  /** Подложка по умолчанию установки сменилась. */
  'basemap.default_changed': z.object({ previousId: Uuid.nullable() }),

  // ── tasks (10-tasks-projects.md, ADR-0060) ─────────────────────────────────
  'task.created': z.object({ key: z.string(), kind: z.string(), assigneeId: Uuid.nullable() }),
  'task.assigned': z.object({
    key: z.string(),
    assigneeId: Uuid,
    previousAssigneeId: Uuid.nullable(),
    /** Основание переназначения (автором или контролёром, ADR-0082). */
    comment: z.string().nullable().optional(),
  }),
  /** Исполнитель принял поручение к исполнению. */
  'task.accepted': z.object({ key: z.string() }),
  'task.status_changed': z.object({
    key: z.string(),
    kind: z.string(),
    from: z.string(),
    to: z.string(),
  }),
  'task.due_changed': z.object({
    key: z.string(),
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
  'task.reported': z.object({ key: z.string() }),
  'task.report_prepared': z.object({ key: z.string(), cause: z.string() }),
  /** Автор или контролёр принял отчёт — поручение закрыто. */
  'task.completed': z.object({ key: z.string() }),
  'task.returned': z.object({ key: z.string(), comment: z.string() }),
  /** Территория задачи изменилась (паспорт территории, ADR-0077). */
  'task.territory_changed': z.object({
    key: z.string(),
    from: Uuid.nullable(),
    to: Uuid.nullable(),
  }),
  // Поручения в полном режиме (ADR-0082)
  /** Исполнитель просит продлить срок: решение — за автором. */
  'task.extension_requested': z.object({
    key: z.string(),
    extensionId: Uuid,
    from: z.string().nullable(),
    to: z.string(),
    reason: z.string(),
  }),
  /** Автор согласовал продление (новый срок — `to`) или отказал. */
  'task.extension_decided': z.object({
    key: z.string(),
    extensionId: Uuid,
    decision: z.enum(['approved', 'rejected']),
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
  /** Напоминание о сроке: за 3 и за 1 рабочий день, в день срока. */
  'task.due_soon': z.object({
    key: z.string(),
    stage: z.enum(['d3', 'd1', 'today']),
    dueAt: z.string(),
    workingDaysLeft: z.number().int(),
  }),
  /** Срок прошёл, поручение не закрыто. */
  'task.overdue': z.object({ key: z.string(), dueAt: z.string() }),
  /** Просрочка передана руководителю исполнителя. */
  'task.escalated': z.object({
    key: z.string(),
    dueAt: z.string(),
    managerId: Uuid,
    afterWorkingDays: z.number().int(),
  }),
  /**
   * Все поручения источника (документа, объекта) закрыты — приняты или отменены:
   * документ может перейти в «Исполнен» (08-documents.md §6).
   */
  'task.source_closed': z.object({
    sourceObjectId: Uuid,
    sourceKind: z.string(),
    resolutionIds: z.array(Uuid),
    total: z.number().int(),
    accepted: z.number().int(),
    cancelled: z.number().int(),
  }),
  'project.created': z.object({ key: z.string(), name: z.string() }),

  // ── calendar (12-calendar-notifications-home.md §1, ADR-0081) ───────────────
  'calendar.created': z.object({ kind: z.string() }),
  /** Название, цвет, пояс, описание или сведения ресурса. */
  'calendar.updated': z.object({ changed: z.array(z.string()) }),
  /** События загружены из файла `.ics` или из канала подписки. */
  'calendar.imported': z.object({
    source: z.enum(['file', 'subscription']),
    created: z.number().int(),
    updated: z.number().int(),
    removed: z.number().int(),
    skipped: z.number().int(),
  }),
  /** Канал подписки не прочитан: адрес недоступен или ответ — не календарь. */
  'calendar.sync_failed': z.object({ error: z.string() }),
  'calendar.feed_created': z.object({ feedId: Uuid }),
  'calendar.feed_revoked': z.object({ feedId: Uuid }),
  /** Объект события — `event`; время первого экземпляра и правило повтора. */
  'event.created': z.object({
    calendarId: Uuid,
    startsAt: z.string(),
    allDay: z.boolean(),
    recurring: z.boolean(),
  }),
  /**
   * Правка: поля, область (`occurrence` — один экземпляр, `following` — серия
   * разделена, `series` — вся серия) и признак переноса времени.
   */
  'event.updated': z.object({
    calendarId: Uuid,
    changed: z.array(z.string()),
    scope: z.enum(['occurrence', 'following', 'series']),
    recurrenceId: z.string().nullable(),
    timeChanged: z.boolean(),
    startsAt: z.string(),
  }),
  /** Отмена события, экземпляра или «этого и следующих». */
  'event.cancelled': z.object({
    calendarId: Uuid,
    scope: z.enum(['occurrence', 'following', 'series']),
    recurrenceId: z.string().nullable(),
  }),
  'event.invited': z.object({ userIds: z.array(Uuid) }),
  'event.uninvited': z.object({ userIds: z.array(Uuid) }),
  'event.responded': z.object({
    userId: Uuid,
    status: z.enum(['accepted', 'tentative', 'declined']),
    proposed: z.boolean(),
  }),
  /** Напоминание экземпляра наступило: доставка — подписчиком через уведомления ядра. */
  'event.reminder': z.object({
    userId: Uuid,
    occurrenceStart: z.string(),
    minutes: z.number().int(),
    channels: z.array(z.string()),
  }),

  // ── meetings (11-communications-meetings.md §3, ADR-0089) ──────────────────
  /** Встреча заведена: звонок из беседы или встреча события календаря. */
  'meeting.scheduled': z.object({
    kind: z.string(),
    eventId: Uuid.nullable(),
    conversationId: Uuid.nullable(),
    participantIds: z.array(Uuid),
  }),
  /** Первый участник вошёл в комнату. */
  'meeting.started': z.object({ kind: z.string(), roomName: z.string() }),
  'meeting.participant_joined': z.object({ userId: Uuid, role: z.string() }),
  'meeting.participant_left': z.object({ userId: Uuid }),
  /** Организатор назначил или снял секретаря — он правит протокол (ADR-0137). */
  'meeting.secretary_changed': z.object({
    secretaryId: Uuid.nullable(),
    previousId: Uuid.nullable(),
  }),
  /** Встреча завершена: вручную, последним вышедшим или отменой события. */
  'meeting.ended': z.object({
    reason: z.enum(['manual', 'empty', 'cancelled']),
    durationSeconds: z.number().int().nullable(),
  }),
  // ── запись и расшифровка встречи (ADR-0092); объект события — запись ──────
  /** Запись включена: индикатор всем участникам комнаты. */
  'recording.started': z.object({ meetingId: Uuid, startedBy: Uuid.nullable() }),
  /** Запись остановлена — медиасервер ещё докладывает файл. */
  'recording.stopped': z.object({ meetingId: Uuid, reason: z.enum(['manual', 'meeting_ended']) }),
  /** Файл записи в реестре: длительность, размер и объект файла. */
  'recording.ready': z.object({
    meetingId: Uuid,
    fileId: Uuid,
    durationSeconds: z.number().int().nullable(),
    sizeBytes: z.number().int().nullable(),
  }),
  'recording.failed': z.object({ meetingId: Uuid, error: z.string() }),
  /** Запись закреплена от удаления по сроку хранения или откреплена (N29, ADR-0138). */
  'recording.pinned': z.object({ meetingId: Uuid, pinned: z.boolean() }),
  /** Организатора предупредили: запись удалится по сроку хранения. */
  'recording.retention_warned': z.object({ meetingId: Uuid, expiresAt: Timestamp }),
  /** Запись удалена по сроку хранения вместе с файлом и расшифровкой. */
  'recording.expired': z.object({ meetingId: Uuid, fileId: Uuid.nullable() }),
  /** Расшифровка готова: сегменты с таймкодами привязаны к записи. */
  'transcript.ready': z.object({
    meetingId: Uuid,
    recordingId: Uuid,
    language: z.string().nullable(),
    segments: z.number().int(),
  }),
  'transcript.failed': z.object({
    meetingId: Uuid,
    recordingId: Uuid,
    /** `unavailable` — модель распознавания не настроена, функция выключена. */
    reason: z.enum(['unavailable', 'failed']),
    error: z.string().nullable(),
  }),

  // ── протокол встречи (11-communications-meetings.md §4, ADR-0093) ─────────
  /** Совместная правка протокола записана: блоки или резюме изменились. */
  'protocol.updated': z.object({ meetingId: Uuid, changed: z.array(z.string()) }),
  /** ИИ дописал в протокол резюме, решения и предложенные поручения. */
  'protocol.drafted': z.object({
    meetingId: Uuid,
    decisions: z.number().int(),
    instructions: z.number().int(),
    usedTranscript: z.boolean(),
  }),
  /** Протокол подтверждён организатором: поручения созданы (`taskIds`). */
  'protocol.confirmed': z.object({
    meetingId: Uuid,
    decisions: z.number().int(),
    taskIds: z.array(Uuid),
  }),
  /** Протокол зарегистрирован документом: дальше — маршрут документа (ADR-0083). */
  'protocol.registered': z.object({ meetingId: Uuid, documentId: Uuid, typeId: Uuid }),
  /** Заказана печатная форма протокола для документа регистрации (N32, ADR-0137). */
  'protocol.print_requested': z.object({ meetingId: Uuid, documentId: Uuid, renderId: Uuid }),
  /** Печатная форма собрана и стала первой версией документа или сборка не удалась. */
  'protocol.printed': z.object({
    meetingId: Uuid,
    documentId: Uuid.nullable(),
    status: z.enum(['ready', 'failed']),
    fileId: Uuid.nullable(),
  }),

  /** Звонок поднят — приглашённым показывается входящий (ADR-0089). */
  'call.incoming': z.object({
    meetingId: Uuid,
    callerId: Uuid.nullable(),
    conversationId: Uuid.nullable(),
    userIds: z.array(Uuid),
  }),
  /** Приглашённый отклонил входящий звонок — звонящий видит это сразу (ADR-0091). */
  'call.declined': z.object({ meetingId: Uuid, userId: Uuid, callerId: Uuid.nullable() }),

  // ── gis (07-gis-engine.md, ADR-0064) ───────────────────────────────────────
  'layer.published': z.object({
    datasetId: Uuid,
    geometryType: z.enum(['point', 'line', 'polygon', 'mixed']),
  }),
  /** Стиль, поля тайла или режим правки слоя: версия слоя сменилась — тайлы заново. */
  'layer.style_changed': z.object({ changed: z.array(z.string()) }),
  'map.updated': z.object({ changed: z.array(z.string()) }),

  // ── gis: правка объектов (07-gis-engine.md §7, ADR-0076) ───────────────────
  // Объект события — слой; строка датасета — rowId, принятая правка — editId
  'feature.created': z.object({
    datasetId: Uuid,
    rowId: z.string(),
    editId: z.string().nullable(),
  }),
  /** fields — изменённые поля (геометрия — ключом своего поля). */
  'feature.updated': z.object({
    datasetId: Uuid,
    rowId: z.string(),
    editId: z.string().nullable(),
    fields: z.array(z.string()),
  }),
  'feature.deleted': z.object({
    datasetId: Uuid,
    rowId: z.string(),
    editId: z.string().nullable(),
  }),
  /** Правка модерируемого слоя ждёт проверки. */
  'feature.edit_submitted': z.object({
    editId: z.string(),
    op: z.enum(['create', 'update', 'delete']),
    datasetId: Uuid,
    rowId: z.string().nullable(),
    authorId: Uuid.nullable(),
  }),
  /** Решение по правке: принята (применена строкой датасета) или отклонена. */
  'feature.edit_reviewed': z.object({
    editId: z.string(),
    op: z.enum(['create', 'update', 'delete']),
    decision: z.enum(['approved', 'rejected']),
    datasetId: Uuid,
    rowId: z.string().nullable(),
    authorId: Uuid.nullable(),
  }),

  // ── process (02-platform-kernel.md §10, ADR-0079) ─────────────────────────
  // Объект события — объект маршрута; stepId — активация шага, stepKey — шаг определения
  'process.started': z.object({
    instanceId: Uuid,
    definitionKey: z.string(),
    version: z.number().int(),
    name: z.string(),
  }),
  /** Шаг активирован: назначенные (для notify — получатели), срок по календарю. */
  'process.step_activated': z.object({
    instanceId: Uuid,
    stepId: Uuid,
    stepKey: z.string(),
    kind: z.string(),
    assignees: z.array(Uuid),
    dueAt: z.string().nullable(),
    template: z.string().nullable().default(null),
  }),
  /** Решение назначенного; userId — чья очередь, actor события — кто нажал. */
  'process.step_decided': z.object({
    instanceId: Uuid,
    stepId: Uuid,
    stepKey: z.string(),
    kind: z.string(),
    decision: z.string(),
    userId: Uuid,
  }),
  'process.step_completed': z.object({
    instanceId: Uuid,
    stepId: Uuid,
    stepKey: z.string(),
    kind: z.string(),
    outcome: z.string(),
  }),
  /** Состав назначенных изменился: добавлен согласующий, шаг передан, переназначен. */
  'process.step_assignees_changed': z.object({
    instanceId: Uuid,
    stepId: Uuid,
    stepKey: z.string(),
    kind: z.string(),
    added: z.array(Uuid),
    removed: z.array(Uuid),
    reason: z.enum(['added', 'delegated', 'reassigned']),
  }),
  /** Напоминание о сроке: за рабочий день и в день срока. */
  'process.step_due_soon': z.object({
    instanceId: Uuid,
    stepId: Uuid,
    stepKey: z.string(),
    kind: z.string(),
    dueAt: z.string(),
    userIds: z.array(Uuid),
    /** За рабочий день, в день срока или незадолго до часового срока (ADR-0131). */
    when: z.enum(['before', 'due_day', 'soon']),
  }),
  /** Срок шага истёк: не ответившие и получатели эскалации по таймерам определения. */
  'process.step_overdue': z.object({
    instanceId: Uuid,
    stepId: Uuid,
    stepKey: z.string(),
    kind: z.string(),
    dueAt: z.string(),
    userIds: z.array(Uuid),
    escalateTo: z.array(Uuid),
  }),
  'process.finished': z.object({
    instanceId: Uuid,
    definitionKey: z.string(),
    status: z.enum(['finished', 'cancelled']),
    outcome: z.string(),
  }),
  /** Определение маршрута: черновик сохранён или снят, версия опубликована. */
  'process.definition_changed': z.object({
    key: z.string(),
    version: z.number().int(),
    change: z.enum(['draft_saved', 'draft_discarded', 'published']),
  }),

  // ── territories (07-gis-engine.md §11, ADR-0067) ──────────────────────────
  /** Граница единицы справочника изменилась: changedFields — geom, centroid, areaKm2. */
  'territory.updated': z.object({ code: z.string() }),

  // ── gis: пространственный анализ (07-gis-engine.md §10, ADR-0069) ──────────
  'analysis.created': z.object({ kind: z.string(), datasetIds: z.array(Uuid) }),
  /** Запуск поставлен в очередь (создание с запуском или перезапуск). */
  'analysis.queued': z.object({ jobId: Uuid }),
  'analysis.started': z.object({ jobId: Uuid }),
  'analysis.finished': z.object({
    jobId: Uuid,
    status: z.enum(['succeeded', 'failed']),
    datasetId: Uuid.nullable(),
    rows: z.number().int().nullable(),
    error: z.string().nullable(),
  }),

  // ── пайплайны преобразований (06-analytics-engine.md §16, ADR-0106) ───────
  'pipeline.created': z.object({ steps: z.number().int(), datasetIds: z.array(Uuid) }),
  /** Определение, расписание или включение изменены. */
  'pipeline.updated': z.object({ changed: z.array(z.string()) }),
  'pipeline.queued': z.object({ jobId: Uuid, runId: Uuid, trigger: z.string() }),
  'pipeline.started': z.object({ jobId: Uuid, runId: Uuid }),
  'pipeline.finished': z.object({
    jobId: Uuid,
    runId: Uuid,
    status: z.enum(['succeeded', 'failed']),
    datasetId: Uuid.nullable(),
    rows: z.number().int().nullable(),
    error: z.string().nullable(),
  }),

  // ── источники датасетов из внешних БД (14-…md §5, ADR-0107) ───────────────
  /** У ленты по адресу (ADR-0132) интеграции может не быть. */
  'source.created': z.object({
    kind: z.string(),
    integrationId: Uuid.nullable(),
    mode: z.string(),
  }),
  'source.updated': z.object({ changed: z.array(z.string()) }),
  'source.queued': z.object({ jobId: Uuid, runId: Uuid, mode: z.string() }),
  'source.synced': z.object({
    jobId: Uuid,
    runId: Uuid,
    datasetId: Uuid,
    rows: z.number().int(),
    inserted: z.number().int(),
    updated: z.number().int(),
    version: z.number().int(),
  }),
  'source.failed': z.object({ jobId: Uuid.nullable(), runId: Uuid, error: z.string() }),

  // ── слои-ссылки на внешние ГИС-службы (07-gis-engine.md §5, ADR-0108) ─────
  'service_layer.created': z.object({ kind: z.string() }),
  'service_layer.updated': z.object({ changed: z.array(z.string()) }),
  'service_layer.checked': z.object({ ok: z.boolean(), message: z.string() }),

  // ── documents (08-documents.md, ADR-0080) ─────────────────────────────────
  'document.created': z.object({ typeKey: z.string(), direction: z.string(), status: z.string() }),
  /** Реквизиты или поля карточки изменены: changed — ключи реквизитов и `fields.<key>`. */
  'document.updated': z.object({ changed: z.array(z.string()) }),
  /**
   * Переход жизненного цикла (08-documents.md §3); cause — доменное действие,
   * source — экземпляр процесса или резолюция, вызвавшие переход (вторая волна).
   */
  'document.status_changed': z.object({
    from: z.string(),
    to: z.string(),
    cause: z.string(),
    source: z.object({ kind: z.string(), id: z.string() }).optional(),
  }),
  'document.registered': z.object({
    number: z.string(),
    journalId: Uuid,
    sequence: z.number().int(),
    year: z.number().int(),
    reserved: z.boolean(),
  }),
  'document.cancelled': z.object({ from: z.string(), reason: z.string() }),
  'document.version_added': z.object({
    versionId: Uuid,
    number: z.number().int(),
    mainFileId: Uuid,
  }),
  /** PDF-представление версии готово или не построено. */
  'document.version_pdf_ready': z.object({ versionId: Uuid, status: z.string() }),
  /** Гриф изменён: доступ пересчитывается (поиск, комнаты, системный датасет). */
  'document.confidentiality_changed': z.object({ from: z.string(), to: z.string() }),
  /**
   * Простая электронная подпись (08-documents.md §9, ADR-0083): хэш подписанной
   * версии (null — движок ещё считает), подписант — чья очередь на шаге.
   */
  'document.signed': z.object({
    signatureId: Uuid,
    versionId: Uuid.nullable(),
    signerId: Uuid,
    stepId: Uuid,
    hash: z.string().nullable(),
    mfa: z.boolean(),
  }),
  /** Участники документа (ответственный, подписант, контролёр, маршрут, резолюции). */
  'document.participants_changed': z.object({
    source: z.string(),
    added: z.array(Uuid),
    removed: z.array(Uuid),
  }),
  /** Документ направлен на резолюцию: правилом типа после регистрации или вручную (ADR-0084). */
  'document.resolution_requested': z.object({
    requestId: Uuid,
    userId: Uuid,
    auto: z.boolean(),
    forwardedFrom: Uuid.nullable().default(null),
  }),
  /** Резолюция наложена; её поручения созданы в той же транзакции (ADR-0084). */
  'document.resolution_added': z.object({
    resolutionId: Uuid,
    parentId: Uuid.nullable(),
    authorId: Uuid,
    responsibleId: Uuid,
    coExecutorIds: z.array(Uuid),
    controllerId: Uuid.nullable(),
    dueDate: z.string(),
    instructionIds: z.array(Uuid),
  }),
  'document_type.created': z.object({ key: z.string(), direction: z.string() }),
  'document_type.updated': z.object({ key: z.string(), changed: z.array(z.string()) }),
  'journal.created': z.object({ name: z.string(), format: z.string() }),
  'journal.updated': z.object({ changed: z.array(z.string()) }),
  /** Номера зарезервированы для бумажных документов (08-documents.md §5). */
  'journal.numbers_reserved': z.object({
    count: z.number().int(),
    first: z.string(),
    last: z.string(),
    year: z.number().int(),
  }),
  'journal.reservation_cancelled': z.object({ reservationId: Uuid, number: z.string() }),
  'correspondent.created': z.object({ kind: z.string(), name: z.string() }),
  'correspondent.updated': z.object({ changed: z.array(z.string()) }),
  /**
   * Рендер модуля документов заказан или завершён (ADR-0085): печатная форма,
   * штамп, заполнение и разбор шаблона, копия с водяным знаком. Объект —
   * документ, журнал, шаблон или файл, к которому относится рендер.
   */
  'document.render_queued': z.object({
    renderId: Uuid,
    kind: z.string(),
    form: z.string().nullable(),
  }),
  'document.render_finished': z.object({
    renderId: Uuid,
    kind: z.string(),
    form: z.string().nullable(),
    status: z.string(),
    fileId: Uuid.nullable(),
  }),
  /** Шаблон документа (объект `template`): создан, изменён, заменён файл. */
  'template.created': z.object({ name: z.string(), typeKey: z.string().nullable() }),
  'template.updated': z.object({ changed: z.array(z.string()) }),

  // ── acknowledgments (08-documents.md §10, ADR-0084) ───────────────────────
  // Объект события — объект, с которым знакомят (документ, страница базы знаний)
  /** Запрос ознакомления: вручную, правилом типа при регистрации или шагом маршрута. */
  'acknowledgment.requested': z.object({
    requestId: Uuid,
    source: z.string(),
    userIds: z.array(Uuid),
    dueAt: z.string().nullable(),
  }),
  /** Сотрудник ознакомился; actor события — кто отметил (заместитель — от имени). */
  'acknowledgment.acknowledged': z.object({
    userId: Uuid,
    requestIds: z.array(Uuid),
    secondFactor: z.boolean(),
  }),
  /** Запрос снят (шаг маршрута отменён, сотрудник снят с шага). */
  'acknowledgment.cancelled': z.object({ requestId: Uuid, userIds: z.array(Uuid) }),
  /** Напоминание не ознакомившимся: вручную или в день срока. */
  'acknowledgment.reminded': z.object({ userIds: z.array(Uuid), auto: z.boolean() }),
  // ── documents: дела, архив, отправка (08-documents.md §5, §12, ADR-0086) ────
  /** Документ подшит в дело номенклатуры. */
  'document.filed': z.object({
    caseId: Uuid,
    index: z.string(),
    caseTitle: z.string(),
    year: z.number().int(),
  }),
  /** Отметка об отправке исходящего; `first` — первая (документ исполнен). */
  'document.dispatched': z.object({
    dispatchId: Uuid,
    method: z.string(),
    sentOn: z.string(),
    addressee: z.string(),
    first: z.boolean(),
  }),
  // ── mail: почта установки (ADR-0150) ──────────────────────────────────────
  /** Сотрудник задал (`set`) или отозвал пароль для почты. */
  'mail.password_changed': z.object({ userId: Uuid, address: z.string(), set: z.boolean() }),
  /** Синхронизация завела новые ящики; `accounts` — всего в файле учёток. */
  'mail.mailboxes_synced': z.object({
    created: z.number().int(),
    accounts: z.number().int(),
  }),
  /** Исходящий поставлен в очередь отправки письмом (ADR-0149). */
  'document.email_queued': z.object({ emailId: Uuid, to: z.string() }),
  /** Письмо принято почтовым сервером; отметка в реестре отправки — `document.dispatched`. */
  'document.email_sent': z.object({
    emailId: Uuid,
    to: z.string(),
    messageId: z.string(),
    dispatchId: Uuid.nullable(),
  }),
  /** Письмо не ушло (`error`, `rejected`) или вернулось от сервера адресата (`bounced`). */
  'document.email_failed': z.object({
    emailId: Uuid,
    to: z.string(),
    reason: z.enum(['error', 'rejected', 'bounced']),
    error: z.string(),
    /** Кто ставил письмо — ему уведомление. */
    createdBy: Uuid.nullable(),
  }),
  /** Файлы документа уничтожены по акту: карточка осталась описью. */
  'document.files_destroyed': z.object({
    actId: Uuid,
    number: z.string(),
    files: z.number().int(),
  }),
  'case.created': z.object({ index: z.string(), year: z.number().int() }),
  'case.updated': z.object({ changed: z.array(z.string()) }),
  'case.closed': z.object({
    index: z.string(),
    year: z.number().int(),
    documents: z.number().int(),
  }),
  'case.reopened': z.object({ index: z.string(), year: z.number().int() }),
  /** Дело передано в архив вместе с документами. */
  'case.archived': z.object({
    index: z.string(),
    year: z.number().int(),
    documents: z.number().int(),
  }),
  /** Дело уничтожено по акту о выделении к уничтожению. */
  'case.destroyed': z.object({ actId: Uuid, number: z.string(), documents: z.number().int() }),

  // ── формы сбора данных (06-analytics-engine.md §13, ADR-0103) ─────────────
  'form.created': z.object({ datasetId: Uuid, periodicity: z.string() }),
  'form.updated': z.object({ changed: z.array(z.string()).default([]) }),
  'form.enabled': z.object({ assignments: z.number().int().nonnegative() }),
  'form.disabled': empty,
  /** Период открыт назначенному: у него появилось дело «Сдать сводку». */
  'form.assigned': z.object({
    submissionId: Uuid,
    periodKey: z.string(),
    subjectKind: z.string(),
    subjectId: Uuid,
    dueAt: Timestamp.nullable().default(null),
  }),
  /**
   * Сводка сдана: строки датасета записаны отправкой. У одиночной формы
   * `rowId` — её строка; у табличной (ADR-0129) — `rowIds` и их число, `rowId` пуст.
   */
  'form.submitted': z.object({
    submissionId: Uuid,
    periodKey: z.string(),
    subjectKind: z.string(),
    subjectId: Uuid,
    rowId: z.string().nullable().default(null),
    rowIds: z.array(z.string()).max(500).default([]),
    rowCount: z.number().int().nonnegative().default(0),
    resubmitted: z.boolean().default(false),
  }),
  /** Сводка принята ответственным. */
  'form.accepted': z.object({
    submissionId: Uuid,
    periodKey: z.string(),
    subjectKind: z.string(),
    subjectId: Uuid,
    authorId: Uuid.nullable().default(null),
  }),
  /** Сводка возвращена на доработку с комментарием. */
  'form.returned': z.object({
    submissionId: Uuid,
    periodKey: z.string(),
    subjectKind: z.string(),
    subjectId: Uuid,
    authorId: Uuid.nullable().default(null),
    comment: z.string(),
  }),
  /** Срок сдачи близок: назначенному напоминают. */
  'form.due_soon': z.object({
    submissionId: Uuid,
    periodKey: z.string(),
    subjectKind: z.string(),
    subjectId: Uuid,
    dueAt: Timestamp,
  }),
  /** Срок сдачи прошёл, сводки нет. */
  'form.overdue': z.object({
    submissionId: Uuid,
    periodKey: z.string(),
    subjectKind: z.string(),
    subjectId: Uuid,
    dueAt: Timestamp,
  }),
  /** Просрочка передана руководителю назначенного. */
  'form.escalated': z.object({
    submissionId: Uuid,
    periodKey: z.string(),
    subjectKind: z.string(),
    subjectId: Uuid,
    dueAt: Timestamp,
    managerId: Uuid,
  }),

  // ── алерты на показатели (06-analytics-engine.md §14, ADR-0104) ───────────
  'alert.created': z.object({ metricId: Uuid, condition: z.string() }),
  'alert.updated': z.object({ changed: z.array(z.string()).default([]) }),
  'alert.enabled': z.object({ cron: z.string() }),
  'alert.disabled': empty,
  /** Условие выполнено: уведомления, Входящие и правила автоматизации. */
  'alert.fired': z.object({
    alertId: Uuid,
    eventId: Uuid,
    metricId: Uuid,
    metricName: z.string(),
    condition: z.string(),
    /** Ключ разреза; пустая строка — показатель целиком. */
    groupKey: z.string().default(''),
    groupLabel: z.string().default(''),
    value: z.number().nullable().default(null),
    base: z.number().nullable().default(null),
    score: z.number().nullable().default(null),
    message: z.string(),
  }),

  // ── автоматизация: правила и входящие вызовы (ADR-0096) ────────────────────
  'rule.created': z.object({ key: z.string(), triggerKind: z.string() }),
  'rule.updated': z.object({ key: z.string(), changed: z.array(z.string()).default([]) }),
  'rule.enabled': z.object({ key: z.string() }),
  'rule.disabled': z.object({ key: z.string() }),
  /** Запуск правила окончательно не выполнен: владелец получает уведомление. */
  'rule.run_failed': z.object({
    runId: Uuid,
    ruleId: Uuid,
    error: z.string(),
    actionIndex: z.number().int().nullable().default(null),
  }),
  // ── admin ─────────────────────────────────────────────────────────────────
  'settings.changed': z.object({ scope: z.string(), key: z.string() }),
  /** День производственного календаря изменён или удалён (`kind: null`). */
  'settings.business_calendar_changed': z.object({
    country: z.string(),
    day: z.string(),
    kind: z.string().nullable(),
  }),
  'acl.changed': z.object({ objectId: Uuid }),
  'role.assigned': z.object({ userId: Uuid, roleKey: z.string() }),
  /** Настройка поставщика входа изменена (каталог, единый вход) — ADR-0098. */
  'integration.configured': z.object({ kind: z.string(), enabled: z.boolean() }),
  /** Прогон синхронизации каталога завершён. */
  'directory.synced': z.object({
    runId: Uuid,
    mode: z.string(),
    status: z.string(),
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  }),
  'announcement.published': z.object({ title: z.string() }),
  'announcement.withdrawn': z.object({ title: z.string() }),

  // ── автоматизация: токены, интеграции, вебхуки (ADR-0097) ─────────────────
  /** Токен публичного API выпущен: сам токен в событие не попадает. */
  'token.created': z.object({
    tokenId: Uuid,
    userId: Uuid,
    prefix: z.string(),
    scopes: z.array(z.string()),
    expiresAt: Timestamp.nullable(),
  }),
  /** Токен отозван владельцем или администратором. */
  'token.revoked': z.object({ tokenId: Uuid, userId: Uuid, prefix: z.string() }),
  'integration.created': z.object({ key: z.string(), kind: z.string() }),
  'integration.updated': z.object({ key: z.string(), changed: z.array(z.string()) }),
  /** Синхронизация завершилась успехом. */
  'integration.synced': z.object({
    key: z.string(),
    kind: z.string(),
    stats: z.record(z.string(), z.unknown()).default({}),
  }),
  /** Синхронизация или проверка связи не удалась. */
  'integration.failed': z.object({ key: z.string(), kind: z.string(), error: z.string() }),
  'webhook.created': z.object({ key: z.string(), url: z.string() }),
  'webhook.updated': z.object({ key: z.string(), changed: z.array(z.string()) }),
  /** Вебхук отключён после серии отказов или вручную. */
  'webhook.disabled': z.object({ key: z.string(), reason: z.string(), failures: z.number().int() }),
  /** Доставка исходящего вебхука завершилась. */
  'webhook.delivered': z.object({
    webhookId: Uuid,
    deliveryId: Uuid,
    eventType: z.string(),
    responseStatus: z.number().int().nullable(),
    attempts: z.number().int(),
  }),
  /** Доставка исходящего вебхука окончательно не удалась. */
  'webhook.failed': z.object({
    webhookId: Uuid,
    deliveryId: Uuid,
    eventType: z.string(),
    attempts: z.number().int(),
    error: z.string(),
  }),
  /**
   * Входящий вызов: вебхук интеграции (`POST /hooks/{integrationId}/{secret}`)
   * или адрес правила (`POST /hooks/rules/{id}/{token}`). Событие — факт
   * получения; тело не разбирается, к нему обращаются условия правил
   * (`event.payload.body.*`), а действия выполняют сами правила.
   */
  'webhook.received': z.object({
    /** Куда пришёл вызов: на адрес интеграции или правила. */
    source: z.enum(['integration', 'rule']).default('integration'),
    /** Интеграция, если вызов пришёл на её адрес. */
    integrationId: Uuid.nullable().default(null),
    /** Устойчивый ключ адреса: ключ интеграции или ключ вызова правила. */
    hookKey: z.string(),
    kind: z.string().default(''),
    /** Тело запроса: JSON-объект или `{ raw: '<текст>' }`. */
    body: z.record(z.string(), z.unknown()).default({}),
    /** Подпись отправителя из заголовка, если он её прислал. */
    signature: z.string().nullable().default(null),
  }),
  // ── почта канцелярии: регистрация входящих из ящика (ADR-0113) ────────────
  /**
   * Письмо разобрано и стало черновиком входящего. Объект события — черновик
   * (если он завёлся); письмо само по себе объектом реестра не становится.
   */
  'mail.received': z.object({
    messageId: Uuid,
    integrationId: Uuid.nullable().default(null),
    documentId: Uuid.nullable().default(null),
    from: z.string(),
    subject: z.string(),
    attachments: z.number().int().nonnegative().default(0),
  }),
  /** Делопроизводитель отклонил письмо: документа не будет, причина записана. */
  'mail.rejected': z.object({ messageId: Uuid, reason: z.string() }),
  /** Письмо не разобралось: оно помечено в очереди «Из почты», а не потеряно. */
  'mail.failed': z.object({ messageId: Uuid, error: z.string() }),
  /** Срок хранения очереди «Из почты»: удалены отклонённые и неразобранные письма (ADR-0136). */
  'mail.purged': z.object({ count: z.number().int(), before: z.string() }),
  /** Пакет конфигурации выгружен. */
  'config.exported': z.object({
    sections: z.array(z.string()),
    items: z.number().int(),
  }),
  /** Пакет конфигурации импортирован. */
  'config.imported': z.object({
    sections: z.array(z.string()),
    applied: z.number().int(),
    skipped: z.number().int(),
  }),
} as const satisfies Record<string, z.ZodType>

export type EventType = keyof typeof EVENT_PAYLOADS
export const EVENT_TYPES = Object.keys(EVENT_PAYLOADS) as EventType[]

export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOADS)[T]>

export function isKnownEventType(type: string): type is EventType {
  return type in EVENT_PAYLOADS
}
