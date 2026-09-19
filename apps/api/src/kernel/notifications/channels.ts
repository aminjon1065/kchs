import type { Locale, NotificationCategory, NotificationChannel } from '@kchs/contracts'

/** Каналы, доставку по которым обеспечивает модуль, а не ядро. */
export type ExternalChannel = Exclude<NotificationChannel, 'app' | 'email'>

export const EXTERNAL_CHANNELS: readonly ExternalChannel[] = ['telegram', 'push']

/** Сообщение внешнего канала: текст уже на языке получателя, ссылка — абсолютная. */
export interface ChannelMessage {
  notificationId: number
  userId: string
  locale: Locale
  category: NotificationCategory
  text: string
  url: string
}

/** Файл получателю — отчёт по расписанию (ADR-0078): подпись уже на его языке. */
export interface ChannelDocument {
  userId: string
  fileName: string
  contentType: string
  content: Buffer
  caption: string
  url: string
  locale: Locale
}

/** Итог отправки файла: отправлен, канал получателю недоступен, сбой. */
export type ChannelDocumentOutcome = 'sent' | 'unavailable' | 'failed'

/**
 * Внешний канал уведомлений (ADR-0061): ядро решает, кому, когда и что
 * отправить, модуль — как доставить. Первый такой канал — Telegram.
 */
export interface NotificationChannelAdapter {
  /** Кому из пользователей канал доступен (аккаунт привязан, канал настроен). */
  available(userIds: string[]): Promise<Set<string>>
  /** Доставка; ошибки канала обрабатывает и журналирует сам адаптер. */
  deliver(messages: ChannelMessage[]): Promise<void>
  /** Файл в канал (бот присылает документ); нет у канала — файлы им не доставляются. */
  sendDocument?(document: ChannelDocument): Promise<ChannelDocumentOutcome>
}

const adapters = new Map<ExternalChannel, NotificationChannelAdapter>()

/** Модуль регистрирует свой канал при старте; `null` снимает регистрацию. */
export function setNotificationChannel(
  channel: ExternalChannel,
  adapter: NotificationChannelAdapter | null,
): void {
  if (adapter) adapters.set(channel, adapter)
  else adapters.delete(channel)
}

export function notificationChannel(channel: ExternalChannel): NotificationChannelAdapter | null {
  return adapters.get(channel) ?? null
}

/** Для каждого получателя — внешние каналы, которые ему сейчас доступны. */
export async function availableChannels(
  userIds: string[],
): Promise<Map<string, Set<ExternalChannel>>> {
  const result = new Map<string, Set<ExternalChannel>>()
  for (const [channel, adapter] of adapters) {
    const users = await adapter.available(userIds)
    for (const userId of users) {
      const set = result.get(userId) ?? new Set<ExternalChannel>()
      set.add(channel)
      result.set(userId, set)
    }
  }
  return result
}
