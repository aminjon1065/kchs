import type { NotificationChannelAdapter } from '~/kernel/notifications/channels.js'
import { systemCtx } from '~/shared/context.js'
import { logger } from '~/shared/logger/index.js'
import { sendTelegramDocument, sendTelegramNotification, telegramConfigured } from './bot.js'
import { TelegramLinks } from './links.js'

/**
 * Канал уведомлений ядра «Telegram» (ADR-0061): доступен тем, кто привязал
 * чат, пока бот настроен. Заблокированный бот снимает привязку.
 */
export const telegramChannel: NotificationChannelAdapter = {
  async available(userIds) {
    if (!telegramConfigured() || userIds.length === 0) return new Set()
    return new Set((await TelegramLinks.chats(userIds)).keys())
  },

  async deliver(messages) {
    if (!telegramConfigured() || messages.length === 0) return
    const chats = await TelegramLinks.chats(messages.map((message) => message.userId))
    for (const message of messages) {
      const chatId = chats.get(message.userId)
      if (chatId === undefined) continue
      const outcome = await sendTelegramNotification(chatId, message)
      if (outcome === 'blocked') {
        logger().info({ userId: message.userId }, 'Telegram: бот заблокирован, привязка снята')
        await TelegramLinks.unlink(
          systemCtx('telegram.blocked', { initiatorId: message.userId }),
          message.userId,
          'blocked',
        )
      }
    }
  },

  /** Отчёт по расписанию — документом в чат получателя (ADR-0078). */
  async sendDocument(document) {
    if (!telegramConfigured()) return 'unavailable'
    const chatId = (await TelegramLinks.chats([document.userId])).get(document.userId)
    if (chatId === undefined) return 'unavailable'
    const outcome = await sendTelegramDocument(chatId, document)
    if (outcome === 'blocked') {
      logger().info({ userId: document.userId }, 'Telegram: бот заблокирован, привязка снята')
      await TelegramLinks.unlink(
        systemCtx('telegram.blocked', { initiatorId: document.userId }),
        document.userId,
        'blocked',
      )
      return 'unavailable'
    }
    return outcome
  },
}
