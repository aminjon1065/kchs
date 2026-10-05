import { sql } from 'drizzle-orm'
import { bigint, index, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { jsonbObject, tsCol } from '../../shared/db/columns.js'
import { objects } from '../objects/schema.js'

// ─── Активность и аудит ──────────────────────────────────────────────────────

export const activities = pgTable(
  'activities',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    eventId: text('event_id'),
    objectId: uuid('object_id').references(() => objects.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id'),
    actorId: uuid('actor_id'),
    onBehalfOf: uuid('on_behalf_of'),
    verb: text('verb').notNull(),
    summary: jsonbObject<{ key: string; params: Record<string, unknown> }>('summary'),
    occurredAt: tsCol('occurred_at').notNull().default(sql`now()`),
  },
  (t) => [
    index('activities_object_idx').on(t.objectId, t.id.desc()),
    index('activities_actor_idx').on(t.actorId, t.id.desc()),
    index('activities_occurred_idx').on(t.occurredAt.desc()),
  ],
)
