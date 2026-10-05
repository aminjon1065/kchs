import { index, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, jsonbObject } from '../../shared/db/columns.js'
import { objects } from '../objects/schema.js'

// ─── Связи и зависимости ─────────────────────────────────────────────────────

export const links = pgTable(
  'links',
  {
    id: uuid('id').primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('related'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    meta: jsonbObject('meta'),
  },
  (t) => [
    uniqueIndex('links_source_target_kind_key').on(t.sourceId, t.targetId, t.kind),
    index('links_target_idx').on(t.targetId),
  ],
)

export const dependencies = pgTable(
  'dependencies',
  {
    fromId: uuid('from_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    toId: uuid('to_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('uses'),
  },
  (t) => [
    primaryKey({ columns: [t.fromId, t.toId, t.kind] }),
    index('dependencies_to_idx').on(t.toId),
  ],
)
