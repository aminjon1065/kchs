import { sql } from 'drizzle-orm'
import {
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
import { jsonbArray, jsonbObject, tsCol } from './_shared.js'
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

/** Источник задачи: строка датасета или объект реестра. */
export type TaskSourceValue =
  | { kind: 'dataset_row'; datasetId: string; rowId: string; label?: string | null }
  | { kind: 'object'; objectId: string }

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
    } | null>(),
    returnComment: text('return_comment'),
    source: jsonb('source').$type<TaskSourceValue | null>(),
    labels: text('labels').array().notNull().default(sql`'{}'::text[]`),
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
  ],
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
