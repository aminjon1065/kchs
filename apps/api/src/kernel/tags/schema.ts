import { sql } from 'drizzle-orm'
import { index, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt } from '../../shared/db/columns.js'
import { objects } from '../objects/schema.js'
import { spaces } from '../spaces/schema.js'

// ─── Теги, избранное, недавние, подписки ─────────────────────────────────────

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey(),
    spaceId: uuid('space_id').references(() => spaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('tags_space_name_key').on(
      sql`coalesce(${t.spaceId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`lower(${t.name})`,
    ),
  ],
)

export const objectTags = pgTable(
  'object_tags',
  {
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    addedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.objectId, t.tagId] }), index('object_tags_tag_idx').on(t.tagId)],
)
