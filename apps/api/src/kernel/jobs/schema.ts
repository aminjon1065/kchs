import { sql } from 'drizzle-orm'
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, jsonbObject, tsCol } from '../../shared/db/columns.js'

// ─── Задания ─────────────────────────────────────────────────────────────────

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey(),
    queue: text('queue').notNull(),
    name: text('name').notNull(),
    objectId: uuid('object_id'),
    initiatorId: uuid('initiator_id'),
    status: text('status').notNull().default('queued'),
    progress: doublePrecision('progress').notNull().default(0),
    message: text('message'),
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    error: jsonb('error').$type<Record<string, unknown> | null>(),
    attempts: integer('attempts').notNull().default(0),
    idempotencyKey: text('idempotency_key'),
    /** Входные данные задания: хранятся до передачи в очередь после коммита. */
    payload: jsonbObject('payload'),
    /** Параметры BullMQ (задержка, число попыток). */
    options: jsonbObject('options'),
    createdAt: createdAt(),
    startedAt: tsCol('started_at'),
    finishedAt: tsCol('finished_at'),
  },
  (t) => [
    index('jobs_status_idx').on(t.status, t.createdAt.desc()),
    index('jobs_object_idx').on(t.objectId),
    index('jobs_initiator_idx').on(t.initiatorId, t.createdAt.desc()),
    uniqueIndex('jobs_idempotency_key')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
)
