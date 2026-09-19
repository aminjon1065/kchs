import type { CalendarProjectionItem, CalendarRangeItem } from '@kchs/contracts'
import type { CalendarItemVariant } from '@kchs/ui'
import { addDays, daysBetween, startOfWeek, wallOf } from './time.js'

export const VIEW_MODES = ['day', 'week', 'month', 'agenda'] as const
export type ViewMode = (typeof VIEW_MODES)[number]

/** Дни вида: неделя с понедельника, месяц — шесть недель, повестка — месяц вперёд. */
export function daysFor(mode: ViewMode, anchor: string): string[] {
  switch (mode) {
    case 'day':
      return [anchor]
    case 'week': {
      const monday = startOfWeek(anchor)
      return Array.from({ length: 7 }, (_, index) => addDays(monday, index))
    }
    case 'month': {
      const first = startOfWeek(`${anchor.slice(0, 7)}-01`)
      return Array.from({ length: 42 }, (_, index) => addDays(first, index))
    }
    default:
      return Array.from({ length: 30 }, (_, index) => addDays(anchor, index))
  }
}

/** Сдвиг якорной даты кнопками «назад / вперёд». */
export function shiftAnchor(mode: ViewMode, anchor: string, direction: 1 | -1): string {
  switch (mode) {
    case 'day':
      return addDays(anchor, direction)
    case 'week':
      return addDays(anchor, 7 * direction)
    case 'month': {
      const [year, month] = anchor.split('-').map(Number)
      const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1 + direction, 1))
      return date.toISOString().slice(0, 10)
    }
    default:
      return addDays(anchor, 30 * direction)
  }
}

/** Как показать экземпляр: занято, приглашение без ответа, «возможно», отказ, свободно. */
export function variantOf(item: CalendarRangeItem): CalendarItemVariant {
  if (item.busy) return 'busy'
  if (item.myStatus === 'declined') return 'declined'
  if (item.invitation && item.myStatus === 'needs_action') return 'pending'
  if (item.myStatus === 'tentative') return 'tentative'
  if (item.showAs === 'free') return 'free'
  return 'solid'
}

export interface TimedPlacement {
  key: string
  item: CalendarRangeItem
  day: number
  start: number
  end: number
  /** Кусок многодневного события — не переносится мышью. */
  partial: boolean
}

/**
 * События со временем по колонкам дней в поясе пользователя: событие через
 * полночь делится на куски по дням.
 */
export function placeTimed(
  items: CalendarRangeItem[],
  days: string[],
  timezone: string,
): TimedPlacement[] {
  const index = new Map(days.map((day, position) => [day, position]))
  const result: TimedPlacement[] = []
  for (const item of items) {
    if (item.allDay) continue
    const start = wallOf(Date.parse(item.startsAt), timezone)
    const end = wallOf(Date.parse(item.endsAt), timezone)
    // Конец ровно в полночь — последний день предыдущий
    const lastDay = end.minute === 0 && end.date > start.date ? addDays(end.date, -1) : end.date
    const span = daysBetween(start.date, lastDay)
    for (let offset = 0; offset <= span; offset++) {
      const day = addDays(start.date, offset)
      const column = index.get(day)
      if (column === undefined) continue
      result.push({
        key: span === 0 ? item.key : `${item.key}#${day}`,
        item,
        day: column,
        start: offset === 0 ? start.minute : 0,
        end: day === lastDay ? (end.date === day ? end.minute : 24 * 60) : 24 * 60,
        partial: span > 0,
      })
    }
  }
  return result
}

export interface AllDayPlacement {
  key: string
  item: CalendarRangeItem
  first: number
  last: number
}

/** События на весь день: даты события, обрезанные видом. */
export function placeAllDay(items: CalendarRangeItem[], days: string[]): AllDayPlacement[] {
  if (days.length === 0) return []
  const firstDay = days[0] as string
  const lastDay = days[days.length - 1] as string
  const result: AllDayPlacement[] = []
  for (const item of items) {
    if (!item.allDay || !item.startDate) continue
    const end = item.endDate ?? item.startDate
    if (end < firstDay || item.startDate > lastDay) continue
    result.push({
      key: item.key,
      item,
      first: Math.max(0, daysBetween(firstDay, item.startDate)),
      last: Math.min(days.length - 1, daysBetween(firstDay, end)),
    })
  }
  return result
}

/** Проекции по дням (сроки задач и документов). */
export function projectionsByDay(
  projections: CalendarProjectionItem[],
): Map<string, CalendarProjectionItem[]> {
  const result = new Map<string, CalendarProjectionItem[]>()
  for (const item of projections) {
    const list = result.get(item.date) ?? []
    list.push(item)
    result.set(item.date, list)
  }
  return result
}

/** Дни, на которые приходится экземпляр (для месяца и повестки). */
export function daysOfItem(item: CalendarRangeItem, timezone: string): string[] {
  if (item.allDay && item.startDate) {
    const end = item.endDate ?? item.startDate
    return Array.from({ length: daysBetween(item.startDate, end) + 1 }, (_, offset) =>
      addDays(item.startDate as string, offset),
    )
  }
  const start = wallOf(Date.parse(item.startsAt), timezone)
  const end = wallOf(Date.parse(item.endsAt), timezone)
  const lastDay = end.minute === 0 && end.date > start.date ? addDays(end.date, -1) : end.date
  return Array.from({ length: daysBetween(start.date, lastDay) + 1 }, (_, offset) =>
    addDays(start.date, offset),
  )
}
