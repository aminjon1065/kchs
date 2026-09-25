import type { TaskSeriesRule } from '@kchs/contracts'
import { zonedDateTime } from '@kchs/fields'
import { addDays, localDate } from '~/kernel/business-calendar/working-days.js'

const DAY_MS = 86_400_000

/** Дней между календарными датами `ГГГГ-ММ-ДД`. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

/** День недели ISO: 1 — понедельник, 7 — воскресенье. */
function isoWeekday(day: string): number {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay()
  return dow === 0 ? 7 : dow
}

/** Понедельник недели даты. */
function weekStart(day: string): string {
  return addDays(day, 1 - isoWeekday(day))
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Число месяца по правилу: -1 — последнее; 31 в коротком месяце — тоже последнее. */
function monthDayOf(year: number, month: number, monthDay: number): number {
  const last = daysInMonth(year, month)
  return monthDay === -1 ? last : Math.min(monthDay, last)
}

/** Подходит ли дата под правило серии, считая периоды от даты начала. */
export function matchesRule(rule: TaskSeriesRule, startsOn: string, day: string): boolean {
  if (day < startsOn) return false
  const interval = Math.max(1, rule.interval)
  if (rule.freq === 'daily') return daysBetween(startsOn, day) % interval === 0
  if (rule.freq === 'weekly') {
    if (!rule.weekdays.includes(isoWeekday(day))) return false
    const weeks = daysBetween(weekStart(startsOn), weekStart(day)) / 7
    return weeks % interval === 0
  }
  const [sy, sm] = startsOn.split('-').map(Number) as [number, number]
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const months = (y - sy) * 12 + (m - sm)
  return months % interval === 0 && d === monthDayOf(y, m, rule.monthDay)
}

/** Момент экземпляра: дата и время правила в поясе организации. */
export function occurrenceAt(rule: TaskSeriesRule, day: string, timezone: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const [hour, minute] = rule.time.split(':').map(Number) as [number, number]
  return zonedDateTime(y, m, d, hour, minute, 0, timezone)
}

/**
 * Следующий экземпляр серии строго после `after` (ADR-0156): дата по правилу, не раньше
 * начала и не позже окончания серии. `null` — экземпляров больше нет. Горизонт поиска —
 * шесть лет: месячное правило с интервалом 12 так найдёт следующий год.
 */
export function nextOccurrence(
  rule: TaskSeriesRule,
  window: { startsOn: string; endsOn: string | null },
  after: Date,
  timezone: string,
): { day: string; at: Date } | null {
  let day = localDate(after, timezone)
  if (day < window.startsOn) day = window.startsOn
  for (let step = 0; step < 366 * 6; step += 1) {
    if (window.endsOn && day > window.endsOn) return null
    if (matchesRule(rule, window.startsOn, day)) {
      const at = occurrenceAt(rule, day, timezone)
      if (at.getTime() > after.getTime()) return { day, at }
    }
    day = addDays(day, 1)
  }
  return null
}
