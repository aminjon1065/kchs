import { date, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import type { LangTextValue } from '../../shared/db/columns.js'

export const businessCalendar = pgTable(
  'business_calendar',
  {
    country: text('country').notNull(),
    day: date('day').notNull(),
    /** work | weekend | holiday | short */
    kind: text('kind').notNull(),
    note: jsonb('note').$type<LangTextValue | null>(),
  },
  (t) => [primaryKey({ columns: [t.country, t.day] })],
)
