import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, updatedAt } from './_shared.js'
import { bytea, users } from './identity.js'

/**
 * Почтовые ящики установки (ADR-0150): ящик сотрудника (`person`, по логину) и общий ящик
 * канцелярии (`registry`). Платформа пишет из них файл учёток почтового сервера. Пароль
 * сотрудника для почты — отдельный от пароля платформы, хранится только хешем `{SSHA512}`,
 * который проверяет Dovecot. Пароль ящика канцелярии нужен самой платформе (отправка
 * исходящих, приём в очередь «Из почты») — он ещё и зашифрован мастер-ключом.
 */
export const mailMailboxes = pgTable(
  'mail_mailboxes',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    address: text('address').notNull(),
    passwordHash: text('password_hash').notNull(),
    /** Пароль задан сотрудником (иначе — случайный, ящик только принимает почту). */
    passwordSet: text('password_set_at'),
    secretEnc: bytea('secret_enc'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('mail_mailboxes_address_uq').on(t.address),
    uniqueIndex('mail_mailboxes_user_uq').on(t.userId),
  ],
)
