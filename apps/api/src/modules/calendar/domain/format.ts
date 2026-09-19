import type { Locale } from '@kchs/contracts'
import { dateWall } from './time.js'

const INTL_LOCALE: Record<Locale, string> = { ru: 'ru-RU', tg: 'tg-TJ', en: 'en-US' }

const cache = new Map<string, Intl.DateTimeFormat>()

function format(locale: Locale, timezone: string, withTime: boolean): Intl.DateTimeFormat {
  const key = `${locale}|${timezone}|${withTime}`
  let formatter = cache.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(INTL_LOCALE[locale] ?? 'ru-RU', {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}),
      timeZone: timezone,
    })
    cache.set(key, formatter)
  }
  return formatter
}

/**
 * Время встречи для текста уведомления и Входящих: на языке и в поясе
 * получателя («пн, 21 сентября, 10:00»); у события на весь день — только дата.
 */
export function formatWhen(
  event: { startsAt: number; allDay: boolean; startDate: string | null },
  locale: Locale,
  options: { timezone: string },
): string {
  if (event.allDay && event.startDate) {
    return format(locale, 'UTC', false).format(new Date(dateWall(event.startDate)))
  }
  return format(locale, options.timezone, true).format(new Date(event.startsAt))
}
