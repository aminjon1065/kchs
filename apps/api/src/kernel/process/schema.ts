import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, jsonbObject, tsCol, updatedAt } from '../../shared/db/columns.js'
import { objects } from '../objects/schema.js'

// ─── Процессы ────────────────────────────────────────────────────────────────

/**
 * Определения маршрутов с версиями (ADR-0079): опубликованная версия
 * неизменна, черновик (`published_at is null`) у ключа один — следующий номер.
 */
export const processDefinitions = pgTable(
  'process_definitions',
  {
    id: uuid('id').primaryKey(),
    key: text('key').notNull(),
    version: integer('version').notNull().default(1),
    objectType: text('object_type').notNull(),
    definition: jsonbObject('definition'),
    publishedAt: tsCol('published_at'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedBy: uuid('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('process_definitions_key_version_key').on(t.key, t.version),
    uniqueIndex('process_definitions_draft_key').on(t.key).where(sql`${t.publishedAt} is null`),
  ],
)

/**
 * Экземпляр маршрута объекта: закреплён за версией определения; в `context` —
 * переменные, выбор инициатора, применённые условия, круг и счётчик шагов.
 */
export const processInstances = pgTable(
  'process_instances',
  {
    id: uuid('id').primaryKey(),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => processDefinitions.id),
    definitionKey: text('definition_key').notNull(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('running'),
    context: jsonbObject('context'),
    startedBy: uuid('started_by'),
    startedAt: createdAt(),
    finishedAt: tsCol('finished_at'),
    outcome: text('outcome'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('process_instances_object_idx').on(t.objectId),
    index('process_instances_status_idx').on(t.status),
    // Один идущий экземпляр маршрута на объект
    uniqueIndex('process_instances_running_key')
      .on(t.objectId, t.definitionKey)
      .where(sql`${t.status} = 'running'`),
  ],
)

/**
 * Активация шага: назначенные и их решения (`assignees`), срок, таймеры
 * (`timers` и ближайший `next_timer_at` — состояние только в базе), итог.
 */
export const processSteps = pgTable(
  'process_steps',
  {
    id: uuid('id').primaryKey(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => processInstances.id, { onDelete: 'cascade' }),
    stepKey: text('step_key').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('active'),
    assignees: jsonb('assignees')
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Назначенные определены (у шага решения без назначенных — ждёт переназначения). */
    resolved: boolean('resolved').notNull().default(false),
    dueAt: tsCol('due_at'),
    startedAt: tsCol('started_at'),
    completedAt: tsCol('completed_at'),
    outcome: text('outcome'),
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    sequence: integer('sequence').notNull().default(0),
    /** Круг согласования: растёт при повторной отправке после возврата. */
    round: integer('round').notNull().default(1),
    /** Параллельный шаг и номер ветви, в которой идёт шаг. */
    parentId: uuid('parent_id'),
    branch: integer('branch'),
    /** Шаг, после которого активирован этот (`previous_step.assignees`). */
    prevId: uuid('prev_id'),
    timers: jsonbObject('timers'),
    nextTimerAt: tsCol('next_timer_at'),
    /** Ожидаемое событие шага `wait`. */
    waitEvent: text('wait_event'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('process_steps_instance_idx').on(t.instanceId, t.sequence),
    index('process_steps_timer_idx')
      .on(t.nextTimerAt)
      .where(sql`${t.status} = 'active' and ${t.nextTimerAt} is not null`),
    index('process_steps_wait_idx')
      .on(t.waitEvent)
      .where(sql`${t.status} = 'active' and ${t.waitEvent} is not null`),
    // Участники шагов: производное право видеть объект (политика типа)
    index('process_steps_assignees_idx').using('gin', sql`${t.assignees} jsonb_path_ops`),
  ],
)

export const processStepActions = pgTable(
  'process_step_actions',
  {
    id: uuid('id').primaryKey(),
    stepId: uuid('step_id')
      .notNull()
      .references(() => processSteps.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id'),
    onBehalfOf: uuid('on_behalf_of'),
    action: text('action').notNull(),
    comment: text('comment'),
    payload: jsonbObject('payload'),
    at: tsCol('at').notNull().default(sql`now()`),
  },
  (t) => [index('process_step_actions_step_idx').on(t.stepId)],
)
