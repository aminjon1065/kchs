import { sql } from 'drizzle-orm'
import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, jsonbObject, tsCol } from '../../shared/db/columns.js'
import { users } from '../directory/schema.js'
import { objects } from '../objects/schema.js'

export const inboxItems = pgTable(
  'inbox_items',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    objectId: uuid('object_id').references(() => objects.id, { onDelete: 'cascade' }),
    processStepId: uuid('process_step_id'),
    titleKey: text('title_key').notNull(),
    params: jsonbObject('params'),
    actorId: uuid('actor_id'),
    /** Элемент продублирован заместителю: чьи это Входящие на самом деле. */
    onBehalfOf: uuid('on_behalf_of'),
    dueAt: tsCol('due_at'),
    priority: text('priority').notNull().default('normal'),
    state: text('state').notNull().default('open'),
    openedAt: createdAt(),
    resolvedAt: tsCol('resolved_at'),
    resolution: text('resolution'),
    snoozedUntil: tsCol('snoozed_until'),
    /** Ключ идемпотентности: (kind, object, user) не дублируется. */
    dedupeKey: text('dedupe_key'),
    payload: jsonbObject('payload'),
  },
  (t) => [
    index('inbox_items_user_idx').on(t.userId, t.state, t.dueAt),
    index('inbox_items_object_idx').on(t.objectId, t.kind),
    uniqueIndex('inbox_items_dedupe_key')
      .on(t.userId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null and ${t.state} in ('open','snoozed')`),
  ],
)

export type InboxItemRow = typeof inboxItems.$inferSelect
