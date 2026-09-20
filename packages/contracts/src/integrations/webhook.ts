import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'

/**
 * Исходящий вебхук (14-automation-integrations.md §4, ADR-0097): подписка на
 * события с фильтром по типам и пространствам, доставка POST с подписью
 * HMAC-SHA256, повторы до суток, журнал доставок.
 */
export const WebhookStatus = z.enum(['active', 'paused', 'disabled'])
export type WebhookStatus = z.infer<typeof WebhookStatus>

export const Webhook = z.object({
  id: Uuid,
  /** Стабильный ключ для пакета конфигурации. */
  key: z.string(),
  name: z.string(),
  url: z.string(),
  status: WebhookStatus,
  /** Типы событий: точное имя или префикс со звёздочкой (`document.*`). */
  eventTypes: z.array(z.string()),
  /** Пустой список — все пространства, доступные владельцу. */
  spaceIds: z.array(Uuid),
  /** Владелец: вебхуку видно только то, что видит он. */
  runAsUserId: Uuid,
  runAsName: z.string().nullable(),
  /** Есть ли секрет подписи (само значение наружу не отдаётся). */
  hasSecret: z.boolean(),
  /** Отказов подряд: после `disableAfterFailures` вебхук отключается. */
  failureStreak: z.number().int().nonnegative(),
  disableAfterFailures: z.number().int().positive(),
  lastDeliveryAt: Timestamp.nullable(),
  lastStatus: z.number().int().nullable(),
  lastError: z.string().nullable(),
  disabledAt: Timestamp.nullable(),
  disabledReason: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Webhook = z.infer<typeof Webhook>

export const WebhookList = z.object({ items: z.array(Webhook) })
export type WebhookList = z.infer<typeof WebhookList>

const eventPattern = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z_]+(\.[a-z_]+)?(\.\*|\*)?$|^\*$/, 'ожидается `домен.событие`, `домен.*` или `*`')

export const WebhookCreateInput = z.object({
  name: z.string().trim().min(1).max(160),
  url: z.url().max(2000),
  eventTypes: z.array(eventPattern).min(1).max(50),
  spaceIds: z.array(Uuid).max(50).default([]),
  /** Секрет подписи: задаётся при создании, иначе генерируется. */
  secret: z.string().min(16).max(200).optional(),
  status: WebhookStatus.default('active'),
  disableAfterFailures: z.number().int().min(1).max(1000).default(20),
})
export type WebhookCreateInput = z.infer<typeof WebhookCreateInput>

export const WebhookUpdateInput = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  url: z.url().max(2000).optional(),
  eventTypes: z.array(eventPattern).min(1).max(50).optional(),
  spaceIds: z.array(Uuid).max(50).optional(),
  secret: z.string().min(16).max(200).optional(),
  status: WebhookStatus.optional(),
  disableAfterFailures: z.number().int().min(1).max(1000).optional(),
})
export type WebhookUpdateInput = z.infer<typeof WebhookUpdateInput>

/** Секрет подписи показывается один раз — при создании или перевыпуске. */
export const WebhookSecret = z.object({ secret: z.string() })
export type WebhookSecret = z.infer<typeof WebhookSecret>

export const WebhookDelivery = z.object({
  id: Uuid,
  webhookId: Uuid,
  eventId: z.string(),
  eventType: z.string(),
  status: z.enum(['pending', 'delivered', 'failed', 'dropped']),
  attempts: z.number().int().nonnegative(),
  responseStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  /** Когда назначена следующая попытка; `null` — повторов больше не будет. */
  nextAttemptAt: Timestamp.nullable(),
  durationMs: z.number().int().nullable(),
  createdAt: Timestamp,
  deliveredAt: Timestamp.nullable(),
})
export type WebhookDelivery = z.infer<typeof WebhookDelivery>

export const WebhookDeliveryList = z.object({
  items: z.array(WebhookDelivery),
  nextCursor: z.string().nullable(),
})
export type WebhookDeliveryList = z.infer<typeof WebhookDeliveryList>

/** Заголовки доставки — контракт для получателя (ADR-0097). */
export const WEBHOOK_HEADERS = {
  event: 'x-kchs-event',
  delivery: 'x-kchs-delivery',
  timestamp: 'x-kchs-timestamp',
  signature: 'x-kchs-signature',
} as const
