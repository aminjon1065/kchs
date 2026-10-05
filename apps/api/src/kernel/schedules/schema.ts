import { boolean, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { updatedAt } from '../../shared/db/columns.js'
import { users } from '../directory/schema.js'

/**
 * Состояние расписаний платформы (14-automation-integrations.md §2):
 * администратор выключает системную проверку, не трогая код. Правила по cron
 * включаются собственным переключателем правила.
 */
export const schedules = pgTable('schedules', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
})
