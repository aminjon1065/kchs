import { sql } from 'drizzle-orm'
import { jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { updatedAt } from '../../shared/db/columns.js'

export const settings = pgTable(
  'settings',
  {
    /** system | space | user */
    scope: text('scope').notNull(),
    scopeId: uuid('scope_id'),
    key: text('key').notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
    updatedBy: uuid('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('settings_pk').on(
      t.scope,
      sql`coalesce(${t.scopeId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.key,
    ),
  ],
)
