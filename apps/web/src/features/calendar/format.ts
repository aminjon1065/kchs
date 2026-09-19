import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { meQuery } from '~/shared/api/queries.js'
import type { ViewMode } from './model.js'
import { clockText, wallOf } from './time.js'

const INTL: Record<string, string> = { ru: 'ru-RU', tg: 'tg-TJ', en: 'en-US' }
const DEFAULT_TIMEZONE = 'Asia/Dushanbe'

export interface CalendarFormat {
  intlLocale: string
  /** Пояс пользователя из профиля. */
  timezone: string
  /** «10:00» в поясе пользователя. */
  time: (instant: number) => string
  /** «10:00–11:30». */
  timeRange: (start: number, end: number) => string
  /** «21 сентября». */
  date: (date: string) => string
  /** «21.09.2026». */
  shortDate: (date: string) => string
  /** «пн». */
  weekday: (date: string) => string
  /** «понедельник, 21 сентября». */
  dayTitle: (date: string) => string
  /** Заголовок вида: «21–27 сентября 2026», «Сентябрь 2026». */
  rangeTitle: (mode: ViewMode, days: string[], anchor: string) => string
  /** Когда событие: «пн, 21 сентября, 10:00–11:00» или «21 сентября, весь день». */
  when: (input: {
    startsAt: string
    endsAt: string
    allDay: boolean
    startDate: string | null
    endDate: string | null
  }) => string
}

const at = (date: string) => new Date(`${date}T00:00:00Z`)

/** Форматирование дат и времени календаря: язык интерфейса, пояс профиля. */
export function useCalendarFormat(): CalendarFormat {
  const locale = useAppearance((s) => s.locale)
  const { data: me } = useQuery(meQuery())
  const timezone = me?.user.timezone ?? DEFAULT_TIMEZONE
  return useMemo(() => {
    const intlLocale = INTL[locale] ?? 'ru-RU'
    const fmt = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(intlLocale, { ...options, timeZone: 'UTC' })
    const dayMonth = fmt({ day: 'numeric', month: 'long' })
    const dayMonthYear = fmt({ day: 'numeric', month: 'long', year: 'numeric' })
    const numeric = fmt({ day: '2-digit', month: '2-digit', year: 'numeric' })
    const weekdayShort = fmt({ weekday: 'short' })
    const full = fmt({ weekday: 'long', day: 'numeric', month: 'long' })
    const monthYear = fmt({ month: 'long', year: 'numeric' })
    const time = (instant: number) => clockText(wallOf(instant, timezone).minute)
    const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
    const format: CalendarFormat = {
      intlLocale,
      timezone,
      time,
      timeRange: (start, end) => `${time(start)}–${time(end)}`,
      date: (date) => dayMonth.format(at(date)),
      shortDate: (date) => numeric.format(at(date)),
      weekday: (date) => weekdayShort.format(at(date)),
      dayTitle: (date) => capitalize(full.format(at(date))),
      rangeTitle: (mode, days, anchor) => {
        if (mode === 'month') return capitalize(monthYear.format(at(`${anchor.slice(0, 7)}-01`)))
        if (mode === 'day') return capitalize(full.format(at(anchor)))
        const first = days[0] ?? anchor
        const last = days[days.length - 1] ?? anchor
        return `${dayMonth.format(at(first))} — ${dayMonthYear.format(at(last))}`
      },
      when: (input) => {
        if (input.allDay && input.startDate) {
          const end = input.endDate ?? input.startDate
          return end === input.startDate
            ? capitalize(full.format(at(input.startDate)))
            : `${dayMonth.format(at(input.startDate))} — ${dayMonth.format(at(end))}`
        }
        const start = Date.parse(input.startsAt)
        const end = Date.parse(input.endsAt)
        const startDay = wallOf(start, timezone).date
        const endDay = wallOf(end, timezone).date
        return startDay === endDay
          ? `${capitalize(full.format(at(startDay)))}, ${time(start)}–${time(end)}`
          : `${dayMonth.format(at(startDay))}, ${time(start)} — ${dayMonth.format(at(endDay))}, ${time(end)}`
      },
    }
    return format
  }, [locale, timezone])
}
