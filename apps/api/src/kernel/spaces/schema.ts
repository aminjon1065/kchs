import { index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, jsonbObject, updatedAt } from '../../shared/db/columns.js'
import { users } from '../directory/schema.js'
import { objects } from '../objects/schema.js'

// ─── Пространства ────────────────────────────────────────────────────────────

export const spaces = pgTable(
  'spaces',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    key: text('key').notNull().unique(),
    kind: text('kind').notNull(),
    unitId: uuid('unit_id'),
    description: text('description'),
    settings: jsonbObject('settings'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('spaces_kind_idx').on(t.kind), index('spaces_unit_idx').on(t.unitId)],
)

export const spaceMembers = pgTable(
  'space_members',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    addedBy: uuid('added_by'),
    addedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.userId] }),
    index('space_members_user_idx').on(t.userId),
  ],
)

export type SpaceRow = typeof spaces.$inferSelect
