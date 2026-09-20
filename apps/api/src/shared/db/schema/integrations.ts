import { sql } from 'drizzle-orm'
import { boolean, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, jsonbObject, tsCol, updatedAt } from './_shared.js'
import { bytea, users } from './identity.js'
import { objects } from './kernel.js'

/**
 * Интеграция — объект реестра с конфигурацией, зашифрованными секретами,
 * статусом и журналом синхронизаций (14-automation-integrations.md §5, ADR-0097).
 * Встроенные службы установки (SMTP, Telegram) строк здесь не имеют: они
 * настраиваются окружением и показываются в списке только для чтения.
 */
export const integrations = pgTable(
  'integrations',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    /** Стабильный ключ переноса между контурами (не UUID). */
    key: text('key').notNull().unique(),
    kind: text('kind').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    description: text('description'),
    /** Конфигурация без секретов: адреса, имена, расписание. */
    config: jsonbObject('config'),
    /** JSON вида `{"password":"…"}`, зашифрованный мастер-ключом. */
    secrets: bytea('secrets'),
    status: text('status').notNull().default('unknown'),
    statusMessage: text('status_message'),
    lastCheckAt: tsCol('last_check_at'),
    lastSyncAt: tsCol('last_sync_at'),
    /** Входящий вебхук: `POST /hooks/{id}/{secret}`. Хранится только хэш секрета. */
    inboundEnabled: boolean('inbound_enabled').notNull().default(false),
    inboundSecretHash: text('inbound_secret_hash'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('integrations_kind_idx').on(t.kind)],
)

/** Журнал синхронизаций интеграции. */
export const integrationSyncs = pgTable(
  'integration_syncs',
  {
    id: uuid('id').primaryKey(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('running'),
    message: text('message'),
    stats: jsonbObject('stats'),
    startedAt: tsCol('started_at').notNull().default(sql`now()`),
    finishedAt: tsCol('finished_at'),
  },
  (t) => [index('integration_syncs_integration_idx').on(t.integrationId, t.startedAt)],
)

/**
 * Исходящий вебхук (14-automation-integrations.md §4): подписка на события
 * с фильтром по типам и пространствам. Секрет подписи зашифрован.
 */
export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    key: text('key').notNull().unique(),
    url: text('url').notNull(),
    status: text('status').notNull().default('active'),
    eventTypes: text('event_types').array().notNull().default(sql`'{}'::text[]`),
    spaceIds: uuid('space_ids').array().notNull().default(sql`'{}'::uuid[]`),
    /** Права доставки: вебхук видит только то, что видит этот человек. */
    runAsUserId: uuid('run_as_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    secret: bytea('secret').notNull(),
    failureStreak: integer('failure_streak').notNull().default(0),
    disableAfterFailures: integer('disable_after_failures').notNull().default(20),
    lastDeliveryAt: tsCol('last_delivery_at'),
    lastStatus: integer('last_status'),
    lastError: text('last_error'),
    disabledAt: tsCol('disabled_at'),
    disabledReason: text('disabled_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('webhooks_status_idx').on(t.status)],
)

/** Журнал доставок: попытки, ответ получателя, время следующей попытки. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    /** Конверт события целиком — тело запроса получателю. */
    payload: jsonbObject('payload'),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    responseStatus: integer('response_status'),
    error: text('error'),
    nextAttemptAt: tsCol('next_attempt_at'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
    deliveredAt: tsCol('delivered_at'),
  },
  (t) => [
    index('webhook_deliveries_hook_idx').on(t.webhookId, t.createdAt),
    uniqueIndex('webhook_deliveries_event_key').on(t.webhookId, t.eventId),
  ],
)

export type IntegrationRow = typeof integrations.$inferSelect
export type WebhookRow = typeof webhooks.$inferSelect
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect
