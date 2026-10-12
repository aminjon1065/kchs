import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { users } from '../../kernel/directory/schema.js'
import { objects } from '../../kernel/objects/schema.js'
import { bytea, createdAt, jsonbObject, tsCol, updatedAt } from '../../shared/db/columns.js'

/**
 * Токен публичного API (14-automation-integrations.md §3, ADR-0097).
 * Токен — учётные данные, как сессия: в базе только хэш, видимая часть
 * (`prefix`) служит для поиска строки и узнавания токена в списке.
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Видимая часть токена: по ней ищется строка, сравнение — по хэшу. */
    prefix: text('prefix').notNull().unique(),
    tokenHash: text('token_hash').notNull().unique(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    /** Кто выпустил: администратор — для служебной учётной записи. */
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: tsCol('expires_at'),
    lastUsedAt: tsCol('last_used_at'),
    lastUsedIp: text('last_used_ip'),
    revokedAt: tsCol('revoked_at'),
    revokedById: uuid('revoked_by_id').references(() => users.id, { onDelete: 'set null' }),
    /** Свой потолок запросов в минуту; `null` — общий лимит установки. */
    rateLimitPerMinute: integer('rate_limit_per_minute'),
    createdAt: createdAt(),
  },
  (t) => [index('api_tokens_user_idx').on(t.userId)],
)

export type ApiTokenRow = typeof apiTokens.$inferSelect

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

/**
 * Подключение (ADR-0206): кто и каким каналом обменивается с платформой —
 * токен API, входящий вебхук или почтовый ящик интеграции, лента, источник из
 * внешней БД, форма сбора, исходящий вебхук, адаптер ЭДО. Строка заводится при
 * первой передаче и хранит то, что не выводится из суточных счётчиков: с какого
 * времени, последняя передача и последняя ошибка.
 */
export const integrationConnections = pgTable(
  'integration_connections',
  {
    /** Что подключено: id токена, интеграции, источника, формы, вебхука, правила. */
    subjectId: uuid('subject_id').notNull(),
    /** Канал обмена: `api`, `webhook_in`, `mail_in`, `feed`, `database`, `form`, `webhook_out`, `edms`. */
    channel: text('channel').notNull(),
    /** Вид подключённого: `token`, `integration`, `source`, `form`, `webhook`, `rule`. */
    kind: text('kind').notNull(),
    /** Название на момент последней передачи: объект могли переименовать. */
    title: text('title').notNull(),
    /** Владелец токена — «кто» для подключений по API. */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    firstAt: tsCol('first_at').notNull().default(sql`now()`),
    lastAt: tsCol('last_at'),
    lastErrorAt: tsCol('last_error_at'),
    lastError: text('last_error'),
  },
  (t) => [primaryKey({ columns: [t.subjectId, t.channel] })],
)

/**
 * Суточные счётчики подключения (ADR-0206): запросы (передачи), записанные
 * строки и ошибки за день по часовому поясу установки. Запросы токенов копятся
 * в Redis и сбрасываются сюда заданием раз в минуту; остальное пишет подписчик
 * событий. Строки старше 400 дней удаляет суточная очистка.
 */
export const integrationUsageDaily = pgTable(
  'integration_usage_daily',
  {
    subjectId: uuid('subject_id').notNull(),
    channel: text('channel').notNull(),
    day: date('day').notNull(),
    requests: bigint('requests', { mode: 'number' }).notNull().default(0),
    rows: bigint('rows', { mode: 'number' }).notNull().default(0),
    errors: bigint('errors', { mode: 'number' }).notNull().default(0),
    lastAt: tsCol('last_at'),
  },
  (t) => [
    primaryKey({ columns: [t.subjectId, t.channel, t.day] }),
    index('integration_usage_daily_day_idx').on(t.day),
  ],
)

/**
 * Отправка в государственную систему ЭДО (ADR-0206, порт `EdmsExchange`):
 * очередь с повторами. Реализации порта пока нет — строки заводит только тот,
 * кто её зарегистрирует; до этого обмен идёт письмом с подписанным экземпляром.
 */
export const edmsSends = pgTable(
  'edms_sends',
  {
    id: uuid('id').primaryKey(),
    /** Документ, который отправляется: id объекта реестра модуля документов. */
    documentId: uuid('document_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    /** Версия документа и номер — что именно ушло. */
    versionNo: integer('version_no'),
    /** Адресат в системе ЭДО: код организации по справочнику системы. */
    recipient: text('recipient').notNull(),
    /** Ключ идемпотентности отправки: повтор не создаёт второй документ у адресата. */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    /** `pending` → `sent` → `delivered`/`rejected`; `failed` — повторы исчерпаны. */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: tsCol('next_attempt_at'),
    /** Идентификатор документа во внешней системе после приёма. */
    externalId: text('external_id'),
    error: text('error'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('edms_sends_document_idx').on(t.documentId),
    index('edms_sends_due_idx').on(t.status, t.nextAttemptAt),
  ],
)

export type EdmsSendRow = typeof edmsSends.$inferSelect
