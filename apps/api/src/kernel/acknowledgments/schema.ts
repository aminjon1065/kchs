import { sql } from 'drizzle-orm'
import { boolean, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tsCol } from '../../shared/db/columns.js'
import { users } from '../directory/schema.js'
import { objects } from '../objects/schema.js'

// ─── Ознакомление ────────────────────────────────────────────────────────────

/**
 * Запрос ознакомления с объектом (08-documents.md §10, ADR-0084): вручную из
 * карточки, правилом типа при регистрации или шагом маршрута `acknowledge`
 * (тогда `process_step_id` — активация шага). Общий для документов и страниц.
 */
export const acknowledgmentRequests = pgTable(
  'acknowledgment_requests',
  {
    id: uuid('id').primaryKey(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    /** manual | register | process */
    source: text('source').notNull(),
    processStepId: uuid('process_step_id'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    requestedAt: tsCol('requested_at').notNull().default(sql`now()`),
    dueAt: tsCol('due_at'),
    requireSecondFactor: boolean('require_second_factor').notNull().default(false),
    note: text('note'),
    cancelledAt: tsCol('cancelled_at'),
  },
  (t) => [
    index('acknowledgment_requests_object_idx').on(t.objectId, t.requestedAt),
    uniqueIndex('acknowledgment_requests_step_uq')
      .on(t.processStepId)
      .where(sql`${t.processStepId} is not null`),
  ],
)

/**
 * Ознакомление сотрудника по запросу (05-data-model.md: `acknowledgments`):
 * ждёт — пока нет ни отметки, ни снятия; отметка — время, кто нажал
 * (заместитель) и подтверждение вторым фактором.
 */
export const acknowledgments = pgTable(
  'acknowledgments',
  {
    id: uuid('id').primaryKey(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => acknowledgmentRequests.id, { onDelete: 'cascade' }),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    requiredAt: tsCol('required_at').notNull().default(sql`now()`),
    dueAt: tsCol('due_at'),
    acknowledgedAt: tsCol('acknowledged_at'),
    /** Кто отметил, если не сам сотрудник (заместитель). */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    secondFactor: boolean('second_factor').notNull().default(false),
    cancelledAt: tsCol('cancelled_at'),
    remindedAt: tsCol('reminded_at'),
    reminders: integer('reminders').notNull().default(0),
  },
  (t) => [
    uniqueIndex('acknowledgments_request_user_uq').on(t.requestId, t.userId),
    index('acknowledgments_object_user_idx').on(t.objectId, t.userId),
    index('acknowledgments_pending_idx')
      .on(t.userId, t.dueAt)
      .where(sql`${t.acknowledgedAt} is null and ${t.cancelledAt} is null`),
  ],
)
