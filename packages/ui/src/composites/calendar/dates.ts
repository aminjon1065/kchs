import type { Locale } from '@kchs/i18n'

/**
 * Календарные даты `ГГГГ-ММ-ДД` без часовых поясов: сетки дизайн-системы
 * работают с днями, а моменты в пояс пользователя переводит приложение.
 */

const DAY_MS = 86_400_000
const INTL: Record<Locale, string> = { ru: 'ru-RU', tg: 'tg-TJ', en: 'en-US' }

export const intlLocale = (locale: Locale) => INTL[locale] ?? 'ru-RU'

const at = (date: string) => Date.parse(`${date}T00:00:00Z`)
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function addDays(date: string, days: number): string {
  return dateOf(at(date) + days * DAY_MS)
}

/** День недели: 0 — воскресенье. */
export function weekday(date: string): number {
  return new Date(at(date)).getUTCDay()
}

/** Начало недели, в которую входит дата. */
export function startOfWeek(date: string, weekStartsOn: 0 | 1 = 1): string {
  return addDays(date, -((weekday(date) - weekStartsOn + 7) % 7))
}

/** Месяц `ГГГГ-ММ` со сдвигом. */
export function addMonths(month: string, months: number): string {
  const [year, index] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year ?? 1970, (index ?? 1) - 1 + months, 1))
  return date.toISOString().slice(0, 7)
}

/** Шесть недель месяца (как в настенном календаре) — даты по неделям. */
export function monthWeeks(month: string, weekStartsOn: 0 | 1 = 1): string[][] {
  const first = startOfWeek(`${month}-01`, weekStartsOn)
  return Array.from({ length: 6 }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => addDays(first, week * 7 + day)),
  )
}

/** Короткие названия дней недели в порядке недели. */
export function weekdayNames(
  locale: Locale,
  weekStartsOn: 0 | 1 = 1,
  width: 'narrow' | 'short' = 'short',
): string[] {
  const format = new Intl.DateTimeFormat(intlLocale(locale), { weekday: width, timeZone: 'UTC' })
  // 4 января 2026 — воскресенье
  return Array.from({ length: 7 }, (_, index) =>
    format.format(new Date(Date.UTC(2026, 0, 4 + ((index + weekStartsOn) % 7)))),
  )
}

/** «Сентябрь 2026». */
export function monthTitle(month: string, locale: Locale): string {
  const text = new Intl.DateTimeFormat(intlLocale(locale), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(at(`${month}-01`)))
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** «понедельник, 21 сентября 2026» — подпись дня для скринридера. */
export function dayLabel(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(at(date)))
}
