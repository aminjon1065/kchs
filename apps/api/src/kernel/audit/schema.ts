import { sql } from 'drizzle-orm'
import { bigint, index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import { jsonbObject, tsCol } from '../../shared/db/columns.js'

/**
 * Неизменяемый журнал безопасности. Партиционирован по месяцам;
 * роль kchs_app имеет только INSERT/SELECT (миграция 0001_hardening).
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity(),
    occurredAt: tsCol('occurred_at').notNull().default(sql`now()`),
    actorId: uuid('actor_id'),
    onBehalfOf: uuid('on_behalf_of'),
    action: text('action').notNull(),
    objectId: uuid('object_id'),
    objectType: text('object_type'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    details: jsonbObject('details'),
    severity: text('severity').notNull().default('info'),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.occurredAt] }),
    index('audit_log_actor_idx').on(t.actorId, t.occurredAt.desc()),
    index('audit_log_object_idx').on(t.objectId, t.occurredAt.desc()),
    index('audit_log_action_idx').on(t.action, t.occurredAt.desc()),
  ],
)
