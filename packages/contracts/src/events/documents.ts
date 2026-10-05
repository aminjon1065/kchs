import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: Модуль «Документы» (08-documents.md). Домены `document`, `document_type`, `case`, `journal`, `correspondent`, `template` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const DOCUMENTS_EVENTS = {
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
} as const satisfies Record<string, z.ZodType>
