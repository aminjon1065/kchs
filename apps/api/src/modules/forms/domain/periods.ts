import type { FormPeriodicity, FormSchedule } from '@kchs/contracts'
import {
  addDays,
  type DayKindOf,
  localDate,
  shiftWorkingDays,
  startOfLocalDay,
  weekday,
} from '~/kernel/business-calendar/working-days.js'

/**
 * Периоды формы сбора данных (06-analytics-engine.md §13, ADR-0103) — чистые
 * функции над датами `ГГГГ-ММ-ДД`. Срок считается от конца периода по
 * производственному календарю, как у поручений: исключения подаёт вызывающий.
 */

export interface FormPeriod {
  /** `2026-09-19`, `2026-W38`, `2026-09`, `once`. */
  key: string
  start: string
  end: string
}

const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

/** Понедельник недели дня. */
export function startOfWeek(day: string): string {
  const dow = weekday(day)
  return addDays(day, dow === 0 ? -6 : 1 - dow)
}

/** Номер недели ISO-8601 и её год. */
function isoWeek(day: string): { year: number; week: number } {
  const thursday = addDays(startOfWeek(day), 3)
  const year = Number(thursday.slice(0, 4))
  const firstThursday = addDays(startOfWeek(`${year}-01-04`), 3)
  const diff = Date.parse(`${thursday}T00:00:00Z`) - Date.parse(`${firstThursday}T00:00:00Z`)
  return { year, week: Math.round(diff / (7 * 24 * HOUR_MS)) + 1 }
}

export function startOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`
}

export function endOfMonth(day: string): string {
  return addDays(addMonths(startOfMonth(day), 1), -1)
}

/** Сдвиг на месяцы от первого числа. */
export function addMonths(firstDay: string, months: number): string {
  const year = Number(firstDay.slice(0, 4))
  const month = Number(firstDay.slice(5, 7)) - 1 + months
  const next = new Date(Date.UTC(year, month, 1))
  return next.toISOString().slice(0, 10)
}

/** Период, которому принадлежит день. */
export function periodOf(day: string, periodicity: FormPeriodicity): FormPeriod {
  switch (periodicity) {
    case 'daily':
      return { key: day, start: day, end: day }
    case 'weekly': {
      const start = startOfWeek(day)
      const { year, week } = isoWeek(day)
      return { key: `${year}-W${String(week).padStart(2, '0')}`, start, end: addDays(start, 6) }
    }
    case 'monthly':
      return { key: day.slice(0, 7), start: startOfMonth(day), end: endOfMonth(day) }
    case 'once':
      return { key: 'once', start: day, end: day }
  }
}

/** Предыдущий период (для `once` — он сам). */
export function previousPeriod(period: FormPeriod, periodicity: FormPeriodicity): FormPeriod {
  if (periodicity === 'once') return period
  return periodOf(addDays(period.start, -1), periodicity)
}

/**
 * Последние `count` периодов, закончившихся не позже `today` включительно с
 * текущим, — от нового к старому. Периоды раньше `startsOn` не возвращаются.
 */
export function recentPeriods(today: string, schedule: FormSchedule, count: number): FormPeriod[] {
  if (schedule.periodicity === 'once') {
    const start = schedule.startsOn ?? today
    const end = schedule.dueOn ?? start
    return [{ key: 'once', start, end }]
  }
  const out: FormPeriod[] = []
  let period = periodOf(today, schedule.periodicity)
  for (let index = 0; index < count; index++) {
    if (schedule.startsOn && period.end < schedule.startsOn) break
    out.push(period)
    period = previousPeriod(period, schedule.periodicity)
  }
  return out
}

/**
 * Периоды, у которых уже наступил срок сдачи, — их и контролирует задание.
 * Текущий, ещё идущий период в список не попадает.
 */
export function closedPeriods(today: string, schedule: FormSchedule, count: number): FormPeriod[] {
  return recentPeriods(today, schedule, count + 1).filter((period) => period.end < today)
}

/**
 * Момент срока сдачи периода: `dueWorkingDays` рабочих дней после конца
 * периода, в указанный час пояса установки. У разовой формы — день `dueOn`.
 */
export function dueAtOf(
  period: FormPeriod,
  schedule: FormSchedule,
  timezone: string,
  kindOf: DayKindOf,
): Date {
  const day =
    schedule.periodicity === 'once'
      ? (schedule.dueOn ?? period.end)
      : shiftWorkingDays(period.end, schedule.dueWorkingDays, kindOf)
  return atTime(day, schedule.time, timezone)
}

/** Момент `ЧЧ:ММ` дня в поясе установки. */
export function atTime(day: string, time: string, timezone: string): Date {
  const hours = Number(time.slice(0, 2))
  const minutes = Number(time.slice(3, 5))
  return new Date(startOfLocalDay(day, timezone).getTime() + hours * HOUR_MS + minutes * MINUTE_MS)
}

/** Промежуток дат, исключения календаря которого нужны срокам периодов. */
export function calendarSpan(periods: readonly FormPeriod[]): { from: string; to: string } | null {
  if (periods.length === 0) return null
  const ends = periods.map((period) => period.end).sort()
  return {
    from: addDays(ends[0] as string, -30),
    to: addDays(ends[ends.length - 1] as string, 60),
  }
}

/** Сегодняшний день в поясе установки. */
export function today(timezone: string, now = new Date()): string {
  return localDate(now, timezone)
}
