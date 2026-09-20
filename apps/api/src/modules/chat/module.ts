import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerFeature } from '~/kernel/features/registry.js'
import { logger } from '~/shared/logger/index.js'
import { chatSubscribers, ensureUnitChannels } from './domain/chat-subscribers.js'
import { ensureMessageIndex } from './domain/message-search.js'
import { PresenceService } from './domain/presence.js'

export { registerChatRoutes } from './http.js'

/**
 * Возможность «Чаты» (15-admin-operations.md §1): установка без мессенджера
 * прячет экран и не отвечает на его маршруты. Объявляется в любой роли —
 * значение читают и маршруты, и подписчики.
 */
export function registerChatFeature(): void {
  registerFeature({
    key: 'chats',
    titleKey: 'admin.features.items.chats.title',
    hintKey: 'admin.features.items.chats.hint',
    tags: ['chat'],
    screens: ['chats'],
  })
}

/**
 * Подписчики модуля «Чаты» — только в роли worker (ADR-0090): уведомления с
 * категориями `chat.*`, индекс сообщений, каналы подразделений, статус
 * «на встрече» по событиям модуля встреч.
 */
export function registerChatBackground(): void {
  for (const subscriber of chatSubscribers) registerSubscriber(subscriber)
}

/**
 * Старт воркера: индекс сообщений, каналы для подразделений, созданных до
 * появления модуля, и сброс «на встрече» (комнаты после перезапуска пусты).
 */
export async function scheduleChatJobs(): Promise<void> {
  try {
    await ensureMessageIndex()
  } catch (error) {
    logger().warn({ err: error }, 'индекс сообщений не готов')
  }
  await PresenceService.clearMeetings()
  await ensureUnitChannels()
}
