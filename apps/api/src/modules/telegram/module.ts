import { TelegramLinkStart, TelegramStatus } from '@kchs/contracts'
import { z } from 'zod'
import { setNotificationChannel } from '~/kernel/notifications/channels.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { sayToTelegramChat, telegramBotUsername, telegramConfigured } from './domain/bot.js'
import { telegramChannel } from './domain/channel.js'
import { TelegramLinks } from './domain/links.js'

export { startTelegramPolling, stopTelegramPolling } from './domain/poller.js'

/** Канал «Telegram» для уведомлений ядра — во всех ролях процесса. */
export function registerTelegramChannel(): void {
  setNotificationChannel('telegram', telegramChannel)
}

export function registerTelegramRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/me/telegram',
    auth: 'session',
    tags: ['integrations'],
    summary: 'Telegram: настроен ли бот и привязан ли чат пользователя',
    schema: { response: { 200: TelegramStatus } },
    handler: async (request) => {
      if (!telegramConfigured()) {
        return { enabled: false, linked: false, username: null, linkedAt: null, botUsername: null }
      }
      const [link, botUsername] = await Promise.all([
        TelegramLinks.get(request.ctx.userId),
        telegramBotUsername(),
      ])
      return {
        enabled: true,
        linked: link !== null,
        username: link?.username ?? null,
        linkedAt: link?.linkedAt ?? null,
        botUsername,
      }
    },
  })

  route({
    method: 'POST',
    url: '/me/telegram/link',
    auth: 'session',
    tags: ['integrations'],
    summary: 'Telegram: одноразовая ссылка привязки на 15 минут',
    schema: { response: { 200: TelegramLinkStart } },
    rateLimit: { max: 10, timeWindow: '1 minute' },
    handler: async (request) => {
      if (!telegramConfigured())
        throw errors.unavailable('Telegram-бот не настроен на этой установке')
      const botUsername = await telegramBotUsername()
      if (!botUsername)
        throw errors.dependencyFailed('Telegram сейчас недоступен, попробуйте позже')
      const { token, expiresAt } = await TelegramLinks.createToken(request.ctx)
      return { url: `https://t.me/${botUsername}?start=${token}`, expiresAt }
    },
  })

  route({
    method: 'DELETE',
    url: '/me/telegram',
    auth: 'session',
    tags: ['integrations'],
    summary: 'Telegram: отвязать чат — уведомления туда больше не приходят',
    schema: { response: { 200: z.object({ ok: z.boolean() }) } },
    handler: async (request) => {
      const chatId = await TelegramLinks.unlink(request.ctx, request.ctx.userId, 'user')
      if (chatId !== null && telegramConfigured()) {
        await sayToTelegramChat(chatId, request.ctx.locale, 'telegram.stopped')
      }
      return { ok: chatId !== null }
    },
  })
}
