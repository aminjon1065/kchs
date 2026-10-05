import { boolean, index, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, jsonbObject, updatedAt } from '../../shared/db/columns.js'
import { objects } from '../objects/schema.js'

// ─── Представления, настройки, календарь ─────────────────────────────────────

export const views = pgTable(
  'views',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    objectType: text('object_type').notNull(),
    definition: jsonbObject('definition'),
    shared: boolean('shared').notNull().default(false),
    pinned: boolean('pinned').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('views_object_type_idx').on(t.objectType)],
)
