import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, jsonbObject, type LangTextValue, tsCol } from './_shared.js'
import { orgUnits, users } from './identity.js'
import { objects, processSteps } from './kernel.js'

/**
 * Документооборот (05-data-model.md §Документы, 08-documents.md, ADR-0080).
 * Название, пространство, владелец, гриф и жизненный цикл объекта — в реестре
 * `objects`; здесь — то, что знает только модуль документов.
 */

/** Тип документа — объект реестра `document_type`; справочник открыт всем сотрудникам. */
export const documentTypes = pgTable(
  'document_types',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: jsonb('name').$type<LangTextValue>().notNull(),
    direction: text('direction').notNull(),
    /** Поля карточки: `{fields: FieldDef[]}` (contracts/field-types.md). */
    cardSchema: jsonbObject<{ fields?: unknown[] }>('card_schema'),
    /** `{journalId, format}` — журнал по умолчанию и свой шаблон номера. */
    numbering: jsonbObject<{ journalId?: string | null; format?: string | null }>('numbering'),
    /** Ключ определения процесса — маршрут по умолчанию (вторая волна). */
    defaultRouteKey: text('default_route_key'),
    retentionYears: integer('retention_years'),
    confidentialityAllowed: text('confidentiality_allowed')
      .array()
      .notNull()
      .default(sql`'{public,internal,confidential}'::text[]`),
    defaultConfidentiality: text('default_confidentiality').notNull().default('internal'),
    printForms: text('print_forms').array().notNull().default(sql`'{}'::text[]`),
    settings: jsonbObject('settings'),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [uniqueIndex('document_types_key_uq').on(t.key)],
)

/**
 * Журнал регистрации — объект реестра `journal`. Зарегистрированные документы —
 * его дочерние объекты: права на журнал (делопроизводители) наследуются ими.
 */
export const journals = pgTable(
  'journals',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull().default(''),
    format: text('format').notNull(),
    /** `year` — счётчик с нового года, `never` — сквозной (год счётчика 0). */
    reset: text('reset').notNull().default('year'),
    unitId: uuid('unit_id').references(() => orgUnits.id, { onDelete: 'set null' }),
    typeIds: uuid('type_ids').array().notNull().default(sql`'{}'::uuid[]`),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [index('journals_unit_idx').on(t.unitId)],
)

/** Счётчик журнала по году: строка блокируется в транзакции регистрации. */
export const journalCounters = pgTable(
  'journal_counters',
  {
    journalId: uuid('journal_id')
      .notNull()
      .references(() => journals.id, { onDelete: 'cascade' }),
    year: integer('year').notNull(),
    lastSeq: integer('last_seq').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.journalId, t.year] })],
)

/** Номера, выданные заранее для бумажных документов (08-documents.md §5). */
export const journalReservations = pgTable(
  'journal_reservations',
  {
    id: uuid('id').primaryKey(),
    journalId: uuid('journal_id')
      .notNull()
      .references(() => journals.id, { onDelete: 'cascade' }),
    year: integer('year').notNull(),
    sequence: integer('sequence').notNull(),
    number: text('number').notNull(),
    note: text('note').notNull(),
    /** open — ждёт документа, used — выдан документу, cancelled — снят. */
    state: text('state').notNull().default('open'),
    reservedBy: uuid('reserved_by').references(() => users.id, { onDelete: 'set null' }),
    reservedAt: createdAt(),
    documentId: uuid('document_id'),
    usedAt: tsCol('used_at'),
  },
  (t) => [
    uniqueIndex('journal_reservations_seq_uq').on(t.journalId, t.year, t.sequence),
    index('journal_reservations_open_idx').on(t.journalId, t.state),
  ],
)

/** Корреспондент — объект реестра `correspondent`: организация или лицо. */
export const correspondents = pgTable(
  'correspondents',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('organization'),
    name: text('name').notNull(),
    details: jsonbObject<Record<string, string>>('details'),
    contacts: jsonbObject<Record<string, string>>('contacts'),
    externalId: text('external_id'),
  },
  (t) => [
    index('correspondents_name_trgm').using('gin', sql`${t.name} extensions.gin_trgm_ops`),
    uniqueIndex('correspondents_external_uq')
      .on(t.externalId)
      .where(sql`${t.externalId} is not null`),
  ],
)

/** Документ — объект реестра `document`. */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    typeId: uuid('type_id')
      .notNull()
      .references(() => documentTypes.id),
    status: text('status').notNull().default('draft'),
    regNumber: text('reg_number'),
    regDate: date('reg_date'),
    journalId: uuid('journal_id').references(() => journals.id, { onDelete: 'set null' }),
    subject: text('subject').notNull().default(''),
    summary: text('summary'),
    correspondentId: uuid('correspondent_id').references(() => correspondents.id, {
      onDelete: 'set null',
    }),
    /** Исходящие реквизиты отправителя входящего документа. */
    externalNumber: text('external_number'),
    externalDate: date('external_date'),
    receivedDate: date('received_date'),
    deliveryMethod: text('delivery_method'),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    responsibleId: uuid('responsible_id').references(() => users.id, { onDelete: 'set null' }),
    signerId: uuid('signer_id').references(() => users.id, { onDelete: 'set null' }),
    deadline: date('deadline'),
    control: text('control').notNull().default('none'),
    controllerId: uuid('controller_id').references(() => users.id, { onDelete: 'set null' }),
    confidentiality: text('confidentiality').notNull().default('internal'),
    /** Поля карточки типа (`cardSchema`). */
    fields: jsonbObject('fields'),
    currentVersionId: uuid('current_version_id'),
    /** Дело номенклатуры — вторая волна (08-documents.md §12). */
    caseId: uuid('case_id'),
    territoryId: uuid('territory_id'),
    unitId: uuid('unit_id').references(() => orgUnits.id, { onDelete: 'set null' }),
    executedAt: tsCol('executed_at'),
    archivedAt: tsCol('archived_at'),
    cancelledAt: tsCol('cancelled_at'),
    cancelReason: text('cancel_reason'),
    /**
     * Принципалы, которым виден документ (как фильтр поиска): системный датасет
     * «Документы» ограничивает строки пересечением с принципалами смотрящего.
     */
    viewers: text('viewers').array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    index('documents_type_status_idx').on(t.typeId, t.status),
    index('documents_reg_number_idx').on(t.regNumber),
    index('documents_journal_idx').on(t.journalId, t.regDate.desc()),
    index('documents_responsible_idx').on(t.responsibleId, t.deadline),
    index('documents_controller_idx').on(t.controllerId),
    index('documents_correspondent_idx').on(t.correspondentId),
    index('documents_fields_idx').using('gin', t.fields),
    check(
      'documents_confidentiality_check',
      sql`${t.confidentiality} in ('public', 'internal', 'confidential', 'secret')`,
    ),
    check('documents_control_check', sql`${t.control} in ('none', 'on', 'done')`),
  ],
)

/**
 * Версия документа: основной файл и приложения (объекты `file`, прикреплённые к
 * документу), PDF-представление для просмотра и подписи, хэш содержимого.
 */
export const documentVersions = pgTable(
  'document_versions',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    mainFileId: uuid('main_file_id').references(() => objects.id, { onDelete: 'set null' }),
    pdfFileId: uuid('pdf_file_id').references(() => objects.id, { onDelete: 'set null' }),
    /** none | pending | ready | failed | unsupported */
    pdfStatus: text('pdf_status').notNull().default('none'),
    /** Идентификаторы файлов-приложений. */
    attachments: jsonb('attachments').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    note: text('note'),
    hash: text('hash'),
    isFinal: boolean('is_final').notNull().default(false),
  },
  (t) => [uniqueIndex('document_versions_number_uq').on(t.documentId, t.number)],
)

/** Регистрация: номер в журнале, уникальный в пределах года счётчика. */
export const registrations = pgTable(
  'registrations',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    journalId: uuid('journal_id')
      .notNull()
      .references(() => journals.id),
    number: text('number').notNull(),
    sequence: integer('sequence').notNull(),
    year: integer('year').notNull(),
    reserved: boolean('reserved').notNull().default(false),
    registeredBy: uuid('registered_by').references(() => users.id, { onDelete: 'set null' }),
    registeredAt: createdAt(),
  },
  (t) => [
    uniqueIndex('registrations_seq_uq').on(t.journalId, t.year, t.sequence),
    index('registrations_document_idx').on(t.documentId),
  ],
)

/**
 * Участники документа — производные права из отношений (03-access-model.md §5):
 * автор, ответственный, подписант, контролёр; вторая волна добавляет участников
 * маршрута и исполнителей резолюций. Права выдаются тихими записями ACL ядра
 * (как у поручений, ADR-0060): так документ одинаково видят проверка доступа,
 * списки, поиск, realtime и системный датасет.
 */
export const documentParticipants = pgTable(
  'document_participants',
  {
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** author | responsible | signer | controller | route | resolution | … */
    role: text('role').notNull(),
    /** Кто выдал: `card` — реквизиты карточки, `route:<экземпляр>`, `resolution:<id>`. */
    source: text('source').notNull().default('card'),
    level: smallint('level').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.userId, t.role, t.source] }),
    index('document_participants_user_idx').on(t.userId),
  ],
)

/**
 * Версия, отправленная шагу маршрута (08-documents.md §4, ADR-0083): активация
 * согласования или подписи замораживает текущую версию документа; линия
 * маршрута и лист согласования показывают, какую версию одобрили и подписали.
 */
export const documentStepVersions = pgTable(
  'document_step_versions',
  {
    stepId: uuid('step_id')
      .primaryKey()
      .references(() => processSteps.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id')
      .notNull()
      .references(() => documentVersions.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [index('document_step_versions_document_idx').on(t.documentId)],
)

/**
 * Простая электронная подпись (08-documents.md §9, ADR-0083): хэш подписанной
 * версии, подписант (чья очередь на шаге), кто нажал (заместитель), сессия и
 * подтверждение вторым фактором. Хэш версии считает движок: пока его нет,
 * подпись ждёт хэш (`hash IS NULL`) и получает его с отчётом движка.
 */
export const documentSignatures = pgTable(
  'document_signatures',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id').references(() => documentVersions.id, { onDelete: 'set null' }),
    stepId: uuid('step_id').references(() => processSteps.id, { onDelete: 'set null' }),
    signerId: uuid('signer_id')
      .notNull()
      .references(() => users.id),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    sessionId: text('session_id'),
    hash: text('hash'),
    /** simple — простая ЭП; qualified — порт SignatureProvider (открытый вопрос). */
    kind: text('kind').notNull().default('simple'),
    mfa: boolean('mfa').notNull().default(false),
    signedAt: tsCol('signed_at').notNull().default(sql`now()`),
  },
  (t) => [
    index('document_signatures_document_idx').on(t.documentId),
    index('document_signatures_version_idx').on(t.versionId),
  ],
)

export type DocumentRow = typeof documents.$inferSelect
export type DocumentTypeRow = typeof documentTypes.$inferSelect
export type JournalRow = typeof journals.$inferSelect
