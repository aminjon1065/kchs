import type { MetricComparison, MetricPeriod, MetricPeriodUnit } from '@kchs/contracts'

const DAY = 86_400_000
const MINUTE = 60_000

/**
 * Окно [from, to) в «настенном» времени пояса: миллисекунды, как если бы часы
 * пояса шли по UTC. В этом пространстве нет переходов на летнее время — сутки
 * всегда сутки; в момент окно переводит `fromWall`.
 */
export interface WallWindow {
  from: number
  to: number
}

export interface MetricWindows {
  /** Окно значения; null — всё время. */
  current: WallWindow | null
  /** Окно базы сравнения: предыдущий период или год назад; иначе null. */
  base: WallWindow | null
  /** Единица относительного периода — для истории и цели; у дат и «всего времени» — null. */
  unit: MetricPeriodUnit | null
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** Настенное время пояса для момента. */
export function toWall(instant: Date | number, timezone: string): number {
  const date = typeof instant === 'number' ? new Date(instant) : instant
  let format = formatters.get(timezone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timezone, format)
  }
  const parts: Record<string, number> = {}
  for (const part of format.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return (
    Date.UTC(
      parts.year ?? 1970,
      (parts.month ?? 1) - 1,
      parts.day ?? 1,
      parts.hour ?? 0,
      parts.minute ?? 0,
      parts.second ?? 0,
    ) + date.getUTCMilliseconds()
  )
}

/** Момент по настенному времени пояса: смещение уточняется на самом моменте (летнее время). */
export function fromWall(wall: number, timezone: string): Date {
  const offset = (at: number) => toWall(at, timezone) - at
  const guess = wall - offset(wall)
  return new Date(wall - offset(guess))
}

/** Начало единицы, в которую попадает настенное время; неделя — с понедельника, как в Postgres. */
export function truncate(wall: number, unit: MetricPeriodUnit): number {
  const date = new Date(wall)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  const day = date.getUTCDate()
  switch (unit) {
    case 'day':
      return Date.UTC(year, month, day)
    case 'week':
      return Date.UTC(year, month, day - ((date.getUTCDay() + 6) % 7))
    case 'month':
      return Date.UTC(year, month, 1)
    case 'quarter':
      return Date.UTC(year, month - (month % 3), 1)
    case 'year':
      return Date.UTC(year, 0, 1)
  }
}

/** Сдвиг на месяцы: число месяца не выходит за его длину (29 февраля → 28-е). */
function shiftMonths(wall: number, months: number): number {
  const date = new Date(wall)
  const index = date.getUTCMonth() + months
  const year = date.getUTCFullYear() + Math.floor(index / 12)
  const month = ((index % 12) + 12) % 12
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return Date.UTC(
    year,
    month,
    Math.min(date.getUTCDate(), last),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  )
}

/** Сдвиг настенного времени на `n` единиц. */
export function shift(wall: number, unit: MetricPeriodUnit, n: number): number {
  switch (unit) {
    case 'day':
      return wall + n * DAY
    case 'week':
      return wall + n * 7 * DAY
    case 'month':
      return shiftMonths(wall, n)
    case 'quarter':
      return shiftMonths(wall, 3 * n)
    case 'year':
      return shiftMonths(wall, 12 * n)
  }
}

/** Дата начала окна (ГГГГ-ММ-ДД). */
export function wallDate(wall: number): string {
  return new Date(truncate(wall, 'day')).toISOString().slice(0, 10)
}

/** Первая дата после окна: неполный последний день входит в окно целиком. */
export function wallDateAfter(wall: number): string {
  const day = truncate(wall, 'day')
  return new Date(day === wall ? day : day + DAY).toISOString().slice(0, 10)
}

/**
 * Окна значения и базы сравнения (ADR-0058). Относительный период — целые
 * календарные единицы в поясе пользователя, как у фильтра `relative`, поэтому
 * значение совпадает с исследованием и графиками. Если период включает текущую,
 * ещё не закончившуюся единицу, база берёт столько же времени от своего начала:
 * «с 1-го по сегодня» сравнивается с тем же отрезком прошлого месяца, а не с
 * целым месяцем. Даты — целые дни включительно; сравнение — такой же длины.
 * «Сейчас» округляется до минуты: одинаковые запросы попадают в кэш.
 */
export function metricWindows(
  period: MetricPeriod | null,
  comparison: MetricComparison,
  now: Date,
  timezone: string,
): MetricWindows {
  if (period === null) return { current: null, base: null, unit: null }
  const nowWall = Math.floor(toWall(now, timezone) / MINUTE) * MINUTE

  let current: WallWindow
  // Окно с текущей, ещё не закончившейся единицей: базе — столько же времени от её начала
  let partial = false
  let cutoff: number
  let units = 0
  let unit: MetricPeriodUnit | null = null
  if ('unit' in period) {
    unit = period.unit
    const start = truncate(nowWall, period.unit)
    current = {
      from: shift(start, period.unit, period.from),
      to: shift(start, period.unit, period.to + 1),
    }
    units = period.to - period.from + 1
    partial = period.to === 0
    cutoff = partial ? Math.min(nowWall, current.to) : current.to
  } else {
    current = {
      from: Date.parse(`${period.start}T00:00:00Z`),
      to: Date.parse(`${period.end}T00:00:00Z`) + DAY,
    }
    cutoff = current.to
  }

  let base: WallWindow | null = null
  if (comparison === 'previous_period') {
    if (unit) {
      const from = shift(current.from, unit, -units)
      base = {
        from,
        to: partial ? Math.min(from + (cutoff - current.from), current.from) : current.from,
      }
    } else {
      const length = current.to - current.from
      base = { from: current.from - length, to: current.from }
    }
  } else if (comparison === 'previous_year') {
    base = { from: shift(current.from, 'year', -1), to: shift(cutoff, 'year', -1) }
  }
  return { current, base, unit }
}
