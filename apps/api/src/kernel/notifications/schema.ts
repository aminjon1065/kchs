import { sql } from 'drizzle-orm'
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, jsonbObject, tsCol } from '../../shared/db/columns.js'
import { users } from '../directory/schema.js'
import { objects } from '../objects/schema.js'

// ─── Уведомления и Входящие ──────────────────────────────────────────────────

export const notifications = pgTable(
  'notifications',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventId: text('event_id'),
    category: text('category').notNull(),
    /** Ключ i18n и параметры вместо готового текста — уведомление локализуется при выдаче. */
    titleKey: text('title_key').notNull(),
    params: jsonbObject('params'),
    objectId: uuid('object_id').references(() => objects.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id'),
    url: text('url'),
    channels: jsonb('channels').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Ключ агрегации: несколько событий одного объекта за окно сливаются. */
    aggregateKey: text('aggregate_key'),
    aggregateCount: integer('aggregate_count').notNull().default(1),
    readAt: tsCol('read_at'),
    /** Когда уведомление ушло на почту (немедленно или в дайджесте). */
    emailedAt: tsCol('emailed_at'),
    /**
     * Ключ повтора (ADR-0171): подписчик, событие и содержание уведомления. Повторная
     * доставка того же события не создаёт второе уведомление получателю.
     */
    dedupeKey: text('dedupe_key'),
    /** Когда уведомление ушло во внешние каналы (Telegram, push); повтор их не шлёт. */
    externalSentAt: tsCol('external_sent_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.id.desc()),
    index('notifications_unread_idx').on(t.userId, t.readAt),
    index('notifications_aggregate_idx').on(t.userId, t.aggregateKey),
    uniqueIndex('notifications_dedupe_idx')
      .on(t.userId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
  ],
)

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    channel: text('channel').notNull(),
    mode: text('mode').notNull().default('immediate'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.category, t.channel] })],
)
