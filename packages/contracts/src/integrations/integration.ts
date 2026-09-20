import { z } from 'zod'
import { Slug, Timestamp, Uuid } from '../common/primitives.js'

/**
 * Интеграция — объект реестра с конфигурацией, зашифрованными секретами,
 * статусом и журналом синхронизаций (14-automation-integrations.md §5, ADR-0097).
 */
export const INTEGRATION_KINDS = [
  'smtp',
  'telegram',
  'imap',
  'ldap',
  'oidc',
  'http',
  's3',
  'sftp',
  'custom',
] as const
export const IntegrationKind = z.enum(INTEGRATION_KINDS)
export type IntegrationKind = z.infer<typeof IntegrationKind>

export const IntegrationStatus = z.enum(['unknown', 'ok', 'error', 'disabled'])
export type IntegrationStatus = z.infer<typeof IntegrationStatus>

/**
 * Откуда интеграция управляется: `object` — запись реестра, `env` — встроенная
 * служба установки (SMTP, Telegram-бот), настроенная переменными окружения.
 * Встроенные показываются в общем списке только для чтения и проверки связи.
 */
export const IntegrationSource = z.enum(['object', 'env'])
export type IntegrationSource = z.infer<typeof IntegrationSource>

export const Integration = z.object({
  id: z.string(),
  source: IntegrationSource,
  /** Стабильный ключ для пакета конфигурации (не UUID). */
  key: Slug,
  kind: IntegrationKind,
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  /** Конфигурация без секретов. */
  config: z.record(z.string(), z.unknown()),
  /** Имена заданных секретов — значения наружу не отдаются никогда. */
  secretKeys: z.array(z.string()),
  status: IntegrationStatus,
  statusMessage: z.string().nullable(),
  lastCheckAt: Timestamp.nullable(),
  lastSyncAt: Timestamp.nullable(),
  /** Включён входящий вебхук `POST /hooks/{id}/{secret}`. */
  inboundEnabled: z.boolean(),
  /** Адрес входящего вебхука без секрета — секрет показывается один раз. */
  inboundUrl: z.string().nullable(),
  createdAt: Timestamp.nullable(),
  updatedAt: Timestamp.nullable(),
})
export type Integration = z.infer<typeof Integration>

export const IntegrationList = z.object({ items: z.array(Integration) })
export type IntegrationList = z.infer<typeof IntegrationList>

export const IntegrationCreateInput = z.object({
  key: Slug,
  kind: IntegrationKind,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).nullable().optional(),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
  /** Секреты: пишутся зашифрованными и наружу не возвращаются. */
  secrets: z.record(z.string(), z.string()).default({}),
  inboundEnabled: z.boolean().default(false),
})
export type IntegrationCreateInput = z.infer<typeof IntegrationCreateInput>

export const IntegrationUpdateInput = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  /** Значение `null` удаляет секрет, строка — задаёт новый. */
  secrets: z.record(z.string(), z.string().nullable()).optional(),
  inboundEnabled: z.boolean().optional(),
})
export type IntegrationUpdateInput = z.infer<typeof IntegrationUpdateInput>

/** Ответ на «Проверить соединение». */
export const IntegrationCheckResult = z.object({
  ok: z.boolean(),
  message: z.string(),
  checkedAt: Timestamp,
})
export type IntegrationCheckResult = z.infer<typeof IntegrationCheckResult>

/** Секрет входящего вебхука: показывается один раз при выпуске. */
export const IntegrationInboundSecret = z.object({ url: z.string(), secret: z.string() })
export type IntegrationInboundSecret = z.infer<typeof IntegrationInboundSecret>

export const IntegrationSync = z.object({
  id: Uuid,
  integrationId: Uuid,
  status: z.enum(['running', 'ok', 'error']),
  message: z.string().nullable(),
  stats: z.record(z.string(), z.unknown()),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
})
export type IntegrationSync = z.infer<typeof IntegrationSync>

export const IntegrationSyncList = z.object({ items: z.array(IntegrationSync) })
export type IntegrationSyncList = z.infer<typeof IntegrationSyncList>
