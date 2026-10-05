import { sql } from 'drizzle-orm'
import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, tsCol } from '../../shared/db/columns.js'

export const announcements = pgTable(
  'announcements',
  {
    id: uuid('id').primaryKey(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    severity: text('severity').notNull().default('info'),
    startsAt: tsCol('starts_at').notNull().default(sql`now()`),
    endsAt: tsCol('ends_at'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('announcements_active_idx').on(t.startsAt, t.endsAt)],
)
