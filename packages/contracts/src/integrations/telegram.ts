import { z } from 'zod'
import { Timestamp } from '../common/primitives.js'

/**
 * Telegram-бот (14-automation-integrations.md, P1-E09 S01, ADR-0061): привязка
 * аккаунта одноразовой ссылкой и уведомления отдельным каналом.
 */
export const TelegramStatus = z.object({
  /** Бот настроен на установке (`TELEGRAM_BOT_TOKEN`). */
  enabled: z.boolean(),
  linked: z.boolean(),
  /** Имя пользователя Telegram, если оно есть. */
  username: z.string().nullable(),
  linkedAt: Timestamp.nullable(),
  /** Имя бота — для подсказки «найдите @…». */
  botUsername: z.string().nullable(),
})
export type TelegramStatus = z.infer<typeof TelegramStatus>

/** Одноразовая ссылка привязки: открыть в Telegram и нажать «Start». */
export const TelegramLinkStart = z.object({
  url: z.string(),
  expiresAt: Timestamp,
})
export type TelegramLinkStart = z.infer<typeof TelegramLinkStart>
