import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, tsCol } from './_shared.js'
import { users } from './identity.js'

/**
 * Подписки push (Web Push, ADR-0094): одна строка — одно устройство (браузер)
 * пользователя. Ключи шифрования даёт браузер; сервер хранит их как есть —
 * без них сообщение не зашифровать. Отписка устройства или ответ 404/410 от
 * службы доставки удаляет строку.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Адрес службы доставки браузера — уникален. */
    endpoint: text('endpoint').notNull().unique(),
    /** Открытый ключ устройства и секрет аутентификации (base64url). */
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    /** Чем подписались — чтобы человек узнал устройство в списке. */
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastSentAt: tsCol('last_sent_at'),
  },
  (t) => [index('push_subscriptions_user_idx').on(t.userId)],
)
