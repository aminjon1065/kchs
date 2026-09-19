import { sql } from 'drizzle-orm'
import { bigint, customType, index, jsonb, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, opsSchema, tsCol, yjsSchema } from './_shared.js'
import { objects } from './kernel.js'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

/**
 * Transactional outbox: событие пишется в той же транзакции, что и данные
 * (02-platform-kernel.md §4). Диспетчер публикует в Redis Streams.
 */
export const outbox = opsSchema.table(
  'outbox',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    domain: text('domain').notNull(),
    event: jsonb('event').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    publishedAt: tsCol('published_at'),
    attempts: bigint('attempts', { mode: 'number' }).notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [
    index('outbox_unpublished_idx').on(t.id).where(sql`${t.publishedAt} is null`),
    index('outbox_published_idx').on(t.publishedAt),
  ],
)

/** Дедупликация обработки событий подписчиками (идемпотентность). */
export const eventConsumptions = opsSchema.table(
  'event_consumptions',
  {
    consumer: text('consumer').notNull(),
    eventId: text('event_id').notNull(),
    processedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.consumer, t.eventId] }),
    index('event_consumptions_time_idx').on(t.processedAt),
  ],
)

/**
 * Документы совместного редактирования (Yjs, ADR-0070): состояние удаляется
 * вместе с объектом.
 */
export const yjsDocuments = yjsSchema.table('documents', {
  objectId: uuid('object_id')
    .primaryKey()
    .references(() => objects.id, { onDelete: 'cascade' }),
  state: bytea('state').notNull(),
  updatedAt: tsCol('updated_at').notNull().default(sql`now()`),
})

export type OutboxRow = typeof outbox.$inferSelect
