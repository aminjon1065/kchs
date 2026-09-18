import { sql } from 'drizzle-orm'
import { bigint, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tsCol } from './_shared.js'
import { users } from './identity.js'

/**
 * Привязка Telegram к пользователю (модуль telegram, ADR-0061): личный чат с
 * ботом получает уведомления. Один чат — один пользователь, у пользователя —
 * один чат; при удалении пользователя привязка исчезает.
 */
export const telegramLinks = pgTable(
  'telegram_links',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Идентификатор личного чата с ботом (совпадает с id пользователя Telegram). */
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    /** Имя пользователя Telegram без «@» — только для показа в профиле. */
    username: text('username'),
    linkedAt: tsCol('linked_at').notNull().default(sql`now()`),
  },
  (t) => [uniqueIndex('telegram_links_chat_key').on(t.chatId)],
)
