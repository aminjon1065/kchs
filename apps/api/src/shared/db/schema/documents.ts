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
    /**
     * Почтовые домены ведомства (ADR-0136): письмо с адреса такого домена или его поддомена
     * получает этого корреспондента при приёме из почты. Домен принадлежит одному корреспонденту.
     */
    mailDomains: text('mail_domains').array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    index('correspondents_name_trgm').using('gin', sql`${t.name} extensions.gin_trgm_ops`),
    index('correspondents_mail_domains_idx').using('gin', t.mailDomains),
    uniqueIndex('correspondents_external_uq')
      .on(t.externalId)
      .where(sql`${t.externalId} is not null`),
  ],
)

/**
 * Дело номенклатуры — объект реестра `case` (08-documents.md §12, ADR-0086):
 * индекс и заголовок по номенклатуре, год, подразделение, срок хранения.
 * Документ подшивается в дело (`documents.case_id`), права на документы дело
 * не меняет: документ остаётся под своим журналом.
 */
export const cases = pgTable(
  'cases',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    index: text('index').notNull(),
    title: text('title').notNull(),
    year: integer('year').notNull(),
    unitId: uuid('unit_id').references(() => orgUnits.id, { onDelete: 'set null' }),
    /** Срок хранения, лет; null — постоянно. */
    retentionYears: integer('retention_years'),
    /** Статья перечня, отметка ЭПК. */
    retentionNote: text('retention_note'),
    documentTypeIds: uuid('document_type_ids').array().notNull().default(sql`'{}'::uuid[]`),
    /** open | closed | archived | destroyed */
    status: text('status').notNull().default('open'),
    note: text('note'),
    closedAt: tsCol('closed_at'),
    closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
    archivedAt: tsCol('archived_at'),
    archivedBy: uuid('archived_by').references(() => users.id, { onDelete: 'set null' }),
    destroyedAt: tsCol('destroyed_at'),
    destructionActId: uuid('destruction_act_id'),
  },
  (t) => [
    uniqueIndex('cases_year_index_uq').on(t.year, sql`lower(${t.index})`),
    index('cases_unit_idx').on(t.unitId, t.year),
    index('cases_status_idx').on(t.status, t.year),
    check('cases_status_check', sql`${t.status} in ('open', 'closed', 'archived', 'destroyed')`),
  ],
)

/**
 * Акт о выделении к уничтожению (ADR-0086): запись операции над делами, как
 * регистрация и резерв номеров у журнала; печатная форма — реестр форм.
 */
export const caseDestructionActs = pgTable(
  'case_destruction_acts',
  {
    id: uuid('id').primaryKey(),
    number: text('number').notNull(),
    year: integer('year').notNull(),
    sequence: integer('sequence').notNull(),
    actDate: date('act_date').notNull(),
    basis: text('basis').notNull(),
    caseIds: uuid('case_ids').array().notNull(),
    documentCount: integer('document_count').notNull().default(0),
    fileCount: integer('file_count').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('case_destruction_acts_seq_uq').on(t.year, t.sequence)],
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
    /** Дело номенклатуры (08-documents.md §12, ADR-0086). */
    caseId: uuid('case_id').references(() => cases.id, { onDelete: 'set null' }),
    /**
     * Дело по номенклатуре, указанное при регистрации: его индекс — в номере, подшивка
     * предлагает его первым (ADR-0134). Отдельно от `case_id`: подшит документ позже.
     */
    regCaseId: uuid('reg_case_id').references(() => cases.id, { onDelete: 'set null' }),
    filedAt: tsCol('filed_at'),
    filedBy: uuid('filed_by').references(() => users.id, { onDelete: 'set null' }),
    /** Файлы версий уничтожены по акту — карточка осталась описью (ADR-0086). */
    filesDestroyedAt: tsCol('files_destroyed_at'),
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
    index('documents_case_idx').on(t.caseId),
    index('documents_fields_idx').using('gin', t.fields),
    check(
      'documents_confidentiality_check',
      sql`${t.confidentiality} in ('public', 'internal', 'confidential')`,
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

/**
 * Резолюция (05-data-model.md: `resolutions`; 08-documents.md §6, ADR-0084):
 * запись руководителя по зарегистрированному документу. Поручения создаёт
 * модуль задач в той же транзакции; их идентификаторы — в `instruction_ids`
 * (основное и части соисполнителей). Вложенная резолюция — `parent_id`.
 */
export const resolutions = pgTable(
  'resolutions',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    /** Внёс делопроизводитель от имени автора; null — сам автор. */
    enteredBy: uuid('entered_by').references(() => users.id, { onDelete: 'set null' }),
    text: text('text').notNull(),
    responsibleId: uuid('responsible_id')
      .notNull()
      .references(() => users.id),
    coExecutors: uuid('co_executors').array().notNull().default(sql`'{}'::uuid[]`),
    deadline: date('deadline').notNull(),
    dueWorkingDays: integer('due_working_days'),
    control: boolean('control').notNull().default(true),
    controllerId: uuid('controller_id').references(() => users.id, { onDelete: 'set null' }),
    instructionIds: uuid('instruction_ids').array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
  },
  (t) => [
    index('resolutions_document_idx').on(t.documentId, t.createdAt),
    index('resolutions_parent_idx').on(t.parentId),
  ],
)

/**
 * Направление на резолюцию (ADR-0084): кому, кем и когда; закрывается
 * резолюцией, «не требует исполнения» или переадресацией. Открытое — одно на
 * документ и сотрудника.
 */
export const resolutionRequests = pgTable(
  'resolution_requests',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    requestedAt: tsCol('requested_at').notNull().default(sql`now()`),
    dueDate: date('due_date'),
    note: text('note'),
    /** open | resolved | no_execution | forwarded | cancelled */
    state: text('state').notNull().default('open'),
    closedAt: tsCol('closed_at'),
    comment: text('comment'),
  },
  (t) => [
    index('resolution_requests_document_idx').on(t.documentId, t.requestedAt),
    uniqueIndex('resolution_requests_open_uq')
      .on(t.documentId, t.userId)
      .where(sql`${t.state} = 'open'`),
  ],
)

/** Шаблоны резолюций: общие (`owner_id` null — ведёт канцелярия) и личные. */
export const resolutionTemplates = pgTable(
  'resolution_templates',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    dueWorkingDays: integer('due_working_days'),
    control: boolean('control').notNull().default(true),
    sort: integer('sort').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('resolution_templates_owner_idx').on(t.ownerId, t.sort)],
)

/**
 * Отметка об отправке исходящего (08-documents.md §5, ADR-0086): кому, каким
 * способом, когда; строки — реестр отправки. Первая отправка переводит
 * зарегистрированный исходящий в «Исполнен».
 */
export const documentDispatches = pgTable(
  'document_dispatches',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    correspondentId: uuid('correspondent_id').references(() => correspondents.id, {
      onDelete: 'set null',
    }),
    addressee: text('addressee'),
    method: text('method').notNull(),
    sentOn: date('sent_on').notNull(),
    tracking: text('tracking'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('document_dispatches_document_idx').on(t.documentId),
    index('document_dispatches_sent_idx').on(t.sentOn),
  ],
)

/**
 * Письма исходящих (ADR-0149): отправка из ящика канцелярии заданием. Отметка в реестре
 * отправки (`document_dispatches`) заводится, только когда сервер принял письмо, — реестр,
 * счётчики и печатный реестр не видят писем в очереди и неудачных. Message-ID — наш: по
 * нему уведомление о недоставке из ящика канцелярии находит своё письмо.
 */
export const documentEmails = pgTable(
  'document_emails',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    correspondentId: uuid('correspondent_id').references(() => correspondents.id, {
      onDelete: 'set null',
    }),
    toAddress: text('to_address').notNull(),
    message: text('message'),
    withAttachments: boolean('with_attachments').notNull().default(true),
    /** `queued` | `sent` | `failed` | `bounced`. */
    status: text('status').notNull().default('queued'),
    messageId: text('message_id'),
    error: text('error'),
    dispatchId: uuid('dispatch_id').references(() => documentDispatches.id, {
      onDelete: 'set null',
    }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    sentAt: tsCol('sent_at'),
  },
  (t) => [
    index('document_emails_document_idx').on(t.documentId),
    uniqueIndex('document_emails_message_idx').on(t.messageId),
  ],
)

/**
 * Шаблон документа — объект реестра `template` (05-data-model.md, 08-documents.md
 * §8, ADR-0085): файл DOCX — вложение шаблона; плейсхолдеры — по разбору движком.
 */
export const templates = pgTable(
  'templates',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    /** Вид шаблона: пока только `docx` (docxtpl). */
    kind: text('kind').notNull().default('docx'),
    name: text('name').notNull(),
    description: text('description'),
    /** Тип документа шаблона; без типа — шаблон подходит любому. */
    documentTypeId: uuid('document_type_id').references(() => documentTypes.id, {
      onDelete: 'set null',
    }),
    fileId: uuid('file_id').references(() => objects.id, { onDelete: 'set null' }),
    /** Карточка по умолчанию: тема, краткое содержание, поля типа. */
    defaults: jsonbObject('defaults'),
    placeholders: text('placeholders').array().notNull().default(sql`'{}'::text[]`),
    unknownPlaceholders: text('unknown_placeholders').array().notNull().default(sql`'{}'::text[]`),
    /** none — файла нет, pending — разбирается, ready, failed. */
    inspectStatus: text('inspect_status').notNull().default('none'),
    inspectError: text('inspect_error'),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [
    index('templates_document_type_idx').on(t.documentTypeId),
    check('templates_kind_check', sql`${t.kind} in ('docx')`),
  ],
)

/**
 * Рендеры модуля документов (ADR-0085): печатные формы и штампы, заполнение и
 * разбор шаблонов, копии с водяным знаком. Строка — заказ задания движка:
 * движок берёт план по её идентификатору, api проверяет права в момент рендера.
 */
export const documentRenders = pgTable(
  'document_renders',
  {
    id: uuid('id').primaryKey(),
    /** print | fill | inspect | watermark */
    kind: text('kind').notNull(),
    /** Документ, журнал, шаблон или файл, к которому относится рендер. */
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    /** Ключ печатной формы; у заполнения — шаблон, у копии — исходный файл. */
    formKey: text('form_key'),
    params: jsonbObject('params'),
    /** queued | running | ready | failed */
    status: text('status').notNull().default('queued'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    /** Заранее выданные идентификаторы файла и ключ результата. */
    target: jsonbObject<Record<string, string>>('target'),
    /** Файл реестра с результатом (печатная форма, заполненный шаблон). */
    fileId: uuid('file_id').references(() => objects.id, { onDelete: 'set null' }),
    pages: integer('pages'),
    size: integer('size'),
    error: text('error'),
    attempts: smallint('attempts').notNull().default(0),
    /** Идемпотентность: штамп — один на регистрацию и версию. */
    dedupeKey: text('dedupe_key'),
    createdAt: createdAt(),
    startedAt: tsCol('started_at'),
    finishedAt: tsCol('finished_at'),
  },
  (t) => [
    index('document_renders_subject_idx').on(t.subjectId, t.createdAt.desc()),
    uniqueIndex('document_renders_dedupe_uq')
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
    check(
      'document_renders_kind_check',
      sql`${t.kind} in ('print', 'fill', 'inspect', 'watermark')`,
    ),
    check(
      'document_renders_status_check',
      sql`${t.status} in ('queued', 'running', 'ready', 'failed')`,
    ),
  ],
)

/**
 * Письмо из ящика канцелярии (08-documents.md §5, ADR-0113). Объектом реестра
 * письмо не становится — им становится черновик входящего, который из письма
 * заводится; здесь остаётся запись очереди «Из почты»: что пришло, во что
 * превратилось и почему не превратилось. Дедупликация — уникальный ключ
 * (ящик, `Message-ID`): одно письмо регистрируется один раз.
 */
export const mailMessages = pgTable(
  'mail_messages',
  {
    id: uuid('id').primaryKey(),
    /** Ящик, из которого письмо забрано; интеграцию могли удалить — история остаётся. */
    integrationId: uuid('integration_id'),
    /** `Message-ID` письма или суррогат `uid:<uidvalidity>:<uid>`, если заголовка нет. */
    messageKey: text('message_key').notNull(),
    /** UID письма в папке — по нему помечаем разобранное. */
    uid: integer('uid'),
    uidValidity: text('uid_validity'),
    fromEmail: text('from_email').notNull().default(''),
    fromName: text('from_name'),
    toEmail: text('to_email'),
    subject: text('subject').notNull().default(''),
    /** Текст письма: то же, что попало в «суть» карточки черновика. */
    body: text('body').notNull().default(''),
    /** Заголовки, нужные для цепочки переписки: `inReplyTo`, `references`. */
    headers: jsonbObject('headers'),
    sentAt: tsCol('sent_at'),
    receivedAt: tsCol('received_at').notNull().default(sql`now()`),
    status: text('status').notNull().default('draft'),
    documentId: uuid('document_id').references(() => objects.id, { onDelete: 'set null' }),
    correspondentId: uuid('correspondent_id').references(() => objects.id, {
      onDelete: 'set null',
    }),
    /** Как найден корреспондент: `email` — по адресу, `domain` — по домену ведомства (ADR-0136). */
    correspondentMatch: text('correspondent_match'),
    /** Файлы-вложения письма, прикреплённые к черновику. */
    attachmentIds: uuid('attachment_ids').array().notNull().default(sql`'{}'::uuid[]`),
    error: text('error'),
    rejectReason: text('reject_reason'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: tsCol('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('mail_messages_key_uq').on(t.integrationId, t.messageKey),
    index('mail_messages_status_idx').on(t.status, t.receivedAt.desc()),
    index('mail_messages_document_idx').on(t.documentId),
    check(
      'mail_messages_status_check',
      sql`${t.status} in ('draft', 'registered', 'rejected', 'failed')`,
    ),
  ],
)

export type DocumentRow = typeof documents.$inferSelect
export type DocumentTypeRow = typeof documentTypes.$inferSelect
export type JournalRow = typeof journals.$inferSelect
export type CaseRow = typeof cases.$inferSelect
export type MailMessageRow = typeof mailMessages.$inferSelect
