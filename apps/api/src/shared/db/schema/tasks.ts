import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  doublePrecision,
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
import { createdAt, jsonbArray, jsonbObject, tsCol } from './_shared.js'
import { users } from './identity.js'
import { objects } from './kernel.js'

/**
 * Задачи, поручения и проекты (05-data-model.md, 10-tasks-projects.md, ADR-0060).
 * Название, пространство, владелец и жизненный цикл — в реестре `objects`;
 * здесь — то, что знает только модуль задач.
 */

/** Проект — объект реестра типа `project`; его задачи — дочерние объекты. */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    leadId: uuid('lead_id').references(() => users.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('active'),
    description: text('description'),
    startsAt: tsCol('starts_at'),
    endsAt: tsCol('ends_at'),
    workflow: jsonbObject<{ statuses?: string[] }>('workflow'),
    customFields: jsonbArray('custom_fields'),
    boardSettings: jsonbObject('board_settings'),
  },
  (t) => [uniqueIndex('projects_key_uq').on(t.key)],
)

/** Источник задачи: строка датасета, объект реестра или резолюция документа. */
export type TaskSourceValue =
  | { kind: 'dataset_row'; datasetId: string; rowId: string; label?: string | null }
  | { kind: 'object'; objectId: string }
  | { kind: 'resolution'; objectId: string; resolutionId: string; label?: string | null }

/** Задача или поручение — объект реестра типа `task`. */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('task'),
    key: text('key').notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    parentId: uuid('parent_id'),
    status: text('status').notNull(),
    priority: smallint('priority').notNull().default(3),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    coAssignees: uuid('co_assignees').array().notNull().default(sql`'{}'::uuid[]`),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    controllerId: uuid('controller_id').references(() => users.id, { onDelete: 'set null' }),
    startAt: tsCol('start_at'),
    dueAt: tsCol('due_at'),
    /** Срок задан как «N рабочих дней» по производственному календарю (ADR-0082). */
    dueWorkingDays: smallint('due_working_days'),
    /** Первоначальный срок — до продлений и изменений. */
    originalDueAt: tsCol('original_due_at'),
    /**
     * Когда установлен действующий срок: напоминания, момент которых раньше
     * этого, не отправляются — человек узнал о сроке при назначении.
     */
    dueSetAt: tsCol('due_set_at'),
    /** Сколько раз срок продлён по запросу исполнителя: отметка «продлено». */
    extensions: smallint('extensions').notNull().default(0),
    /** Исполнитель принял поручение к исполнению (задачу — взял в работу). */
    startedAt: tsCol('started_at'),
    reportedAt: tsCol('reported_at'),
    /** Закрыта: принята автором (поручение) или готова (задача). */
    completedAt: tsCol('completed_at'),
    requiresAcceptance: boolean('requires_acceptance').notNull().default(false),
    description: text('description'),
    result: jsonb('result').$type<{
      text: string
      reportedAt: string
      reportedBy: string | null
      /** Вложения и ссылки на объекты отчёта (ADR-0082). */
      objectIds?: string[]
    } | null>(),
    returnComment: text('return_comment'),
    /**
     * Готовый отчёт (N22, ADR-0136): подготовлен системой по событию — например, ответ на
     * входящий отправлен; исполнитель отправляет его одной кнопкой или правит.
     */
    reportDraft: jsonb('report_draft').$type<{
      text: string
      objectIds: string[]
      cause: 'reply_dispatched'
      /** Объект-основание: по нему повтор события не готовит отчёт заново. */
      sourceObjectId: string
      preparedAt: string
    } | null>(),
    source: jsonb('source').$type<TaskSourceValue | null>(),
    labels: text('labels').array().notNull().default(sql`'{}'::text[]`),
    /**
     * Территория задачи (ADR-0077): единица справочника модуля GIS, без внешнего
     * ключа — модули не связаны таблицами, как `org_units.territory_id`.
     */
    territoryId: uuid('territory_id'),
    /**
     * Подразделение исполнителя (основное место работы) для матрицы контроля
     * (ADR-0082): у открытого поручения следует за исполнителем, у закрытого —
     * остаётся тем, где его исполнили. Без внешнего ключа, как `territory_id`.
     */
    unitId: uuid('unit_id'),
    fields: jsonbObject('fields'),
    order: doublePrecision('order').notNull().default(0),
    /**
     * Кто видит задачу — принципалы в форме множества принципалов ядра
     * (`user:…`, `space_role:…:viewer`), как у фильтра поиска. Ведёт модуль
     * задач по событиям прав; нужен системному датасету `tasks` (ADR-0060).
     */
    viewers: text('viewers').array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    uniqueIndex('tasks_key_uq').on(t.key),
    index('tasks_assignee_idx').on(t.assigneeId, t.status, t.dueAt),
    index('tasks_author_idx').on(t.authorId, t.status),
    index('tasks_controller_idx').on(t.controllerId),
    index('tasks_project_idx').on(t.projectId, t.status),
    index('tasks_co_assignees_idx').using('gin', t.coAssignees),
    index('tasks_source_idx').on(sql`(${t.source}->>'datasetId')`),
    index('tasks_source_object_idx').on(sql`(${t.source}->>'objectId')`),
    index('tasks_territory_idx').on(t.territoryId),
    index('tasks_parent_idx').on(t.parentId),
    index('tasks_unit_idx').on(t.unitId),
    index('tasks_due_open_idx')
      .on(t.dueAt)
      .where(sql`${t.kind} = 'instruction' and ${t.status} not in ('accepted', 'cancelled')`),
  ],
)

/**
 * История сроков поручения (10-tasks-projects.md §4, ADR-0082): кто, когда,
 * с какого срока на какой и почему — назначение, правка, возврат, продление.
 */
export const taskDueChanges = pgTable(
  'task_due_changes',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    fromDue: tsCol('from_due'),
    toDue: tsCol('to_due'),
    workingDays: smallint('working_days'),
    /** set | edit | return | extension | parent */
    reason: text('reason').notNull(),
    comment: text('comment'),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    onBehalfOf: uuid('on_behalf_of'),
    extensionId: uuid('extension_id'),
    createdAt: createdAt(),
  },
  (t) => [index('task_due_changes_task_idx').on(t.taskId, t.id)],
)

/**
 * Запросы продления срока (ADR-0082): исполнитель просит, автор решает. Ждать
 * решения может только один запрос поручения.
 */
export const taskExtensions = pgTable(
  'task_extensions',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** pending | approved | rejected | cancelled */
    status: text('status').notNull().default('pending'),
    fromDue: tsCol('from_due'),
    requestedDue: tsCol('requested_due').notNull(),
    requestedWorkingDays: smallint('requested_working_days'),
    reason: text('reason').notNull(),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    requestedOnBehalfOf: uuid('requested_on_behalf_of'),
    requestedAt: createdAt(),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedOnBehalfOf: uuid('decided_on_behalf_of'),
    decidedAt: tsCol('decided_at'),
    decisionComment: text('decision_comment'),
    approvedDue: tsCol('approved_due'),
  },
  (t) => [
    index('task_extensions_task_idx').on(t.taskId, t.requestedAt),
    uniqueIndex('task_extensions_pending_uq').on(t.taskId).where(sql`${t.status} = 'pending'`),
  ],
)

/**
 * Отправленные напоминания и эскалации (ADR-0082): ключ — поручение, этап и
 * срок. Вставка строки и событие — в одной транзакции, поэтому повтор задания
 * и перезапуск воркера не дают дублей, а новый срок напоминает заново.
 */
export const taskReminders = pgTable(
  'task_reminders',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** d3 | d1 | today | overdue | escalated */
    stage: text('stage').notNull(),
    dueAt: tsCol('due_at').notNull(),
    firedAt: createdAt(),
    /** Этап пропущен: наступил позже следующего (воркер стоял) — отправлен только последний. */
    skipped: boolean('skipped').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.stage, t.dueAt] })],
)

/** Счётчики ключей: `project:<id>` → `FLD-N`, `instruction`/`task` по году → `П-26-N`. */
export const taskCounters = pgTable(
  'task_counters',
  {
    scope: text('scope').notNull(),
    year: integer('year').notNull(),
    lastSeq: integer('last_seq').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.scope, t.year] })],
)
