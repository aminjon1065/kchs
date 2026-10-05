import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'

/**
 * События: Модуль «Интеграции»: токены, интеграции, вебхуки, пакет конфигурации (ADR-0097). Домены `integration`, `webhook`, `token`, `config` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const INTEGRATIONS_EVENTS = {
  /** Настройка поставщика входа изменена (каталог, единый вход) — ADR-0098. */
  'integration.configured': z.object({ kind: z.string(), enabled: z.boolean() }),

  // ── автоматизация: токены, интеграции, вебхуки (ADR-0097) ─────────────────
  /** Токен публичного API выпущен: сам токен в событие не попадает. */
  'token.created': z.object({
    tokenId: Uuid,
    userId: Uuid,
    prefix: z.string(),
    scopes: z.array(z.string()),
    expiresAt: Timestamp.nullable(),
  }),
  /** Токен отозван владельцем или администратором. */
  'token.revoked': z.object({ tokenId: Uuid, userId: Uuid, prefix: z.string() }),
  'integration.created': z.object({ key: z.string(), kind: z.string() }),
  'integration.updated': z.object({ key: z.string(), changed: z.array(z.string()) }),
  /** Синхронизация завершилась успехом. */
  'integration.synced': z.object({
    key: z.string(),
    kind: z.string(),
    stats: z.record(z.string(), z.unknown()).default({}),
  }),
  /** Синхронизация или проверка связи не удалась. */
  'integration.failed': z.object({ key: z.string(), kind: z.string(), error: z.string() }),
  'webhook.created': z.object({ key: z.string(), url: z.string() }),
  'webhook.updated': z.object({ key: z.string(), changed: z.array(z.string()) }),
  /** Вебхук отключён после серии отказов или вручную. */
  'webhook.disabled': z.object({ key: z.string(), reason: z.string(), failures: z.number().int() }),
  /** Доставка исходящего вебхука завершилась. */
  'webhook.delivered': z.object({
    webhookId: Uuid,
    deliveryId: Uuid,
    eventType: z.string(),
    responseStatus: z.number().int().nullable(),
    attempts: z.number().int(),
  }),
  /** Доставка исходящего вебхука окончательно не удалась. */
  'webhook.failed': z.object({
    webhookId: Uuid,
    deliveryId: Uuid,
    eventType: z.string(),
    attempts: z.number().int(),
    error: z.string(),
  }),
  /**
   * Входящий вызов: вебхук интеграции (`POST /hooks/{integrationId}/{secret}`)
   * или адрес правила (`POST /hooks/rules/{id}/{token}`). Событие — факт
   * получения; тело не разбирается, к нему обращаются условия правил
   * (`event.payload.body.*`), а действия выполняют сами правила.
   */
  'webhook.received': z.object({
    /** Куда пришёл вызов: на адрес интеграции или правила. */
    source: z.enum(['integration', 'rule']).default('integration'),
    /** Интеграция, если вызов пришёл на её адрес. */
    integrationId: Uuid.nullable().default(null),
    /** Устойчивый ключ адреса: ключ интеграции или ключ вызова правила. */
    hookKey: z.string(),
    kind: z.string().default(''),
    /** Тело запроса: JSON-объект или `{ raw: '<текст>' }`. */
    body: z.record(z.string(), z.unknown()).default({}),
    /** Подпись отправителя из заголовка, если он её прислал. */
    signature: z.string().nullable().default(null),
  }),
  /** Пакет конфигурации выгружен. */
  'config.exported': z.object({
    sections: z.array(z.string()),
    items: z.number().int(),
  }),
  /** Пакет конфигурации импортирован. */
  'config.imported': z.object({
    sections: z.array(z.string()),
    applied: z.number().int(),
    skipped: z.number().int(),
  }),
} as const satisfies Record<string, z.ZodType>
