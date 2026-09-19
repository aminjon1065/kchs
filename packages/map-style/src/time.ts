/**
 * Даты в условиях стиля. В тайлах и объектах слоя дата и дата-время — числа,
 * миллисекунды эпохи (ADR-0065): поле `date` — полночь UTC календарной даты,
 * `datetime` — момент. «Весь день» для даты-времени считается в поясе контекста,
 * как в компиляторе запросов (`packages/query`).
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/

export interface Day {
  year: number
  month: number
  day: number
}

export type Moment = { kind: 'day'; day: Day } | { kind: 'instant'; ms: number }

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timezone: string): Intl.DateTimeFormat {
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
  return format
}

/** Местные дата и время момента в поясе. */
function localParts(
  ms: number,
  timezone: string,
): Day & { hour: number; minute: number; second: number } {
  const parts = formatter(timezone).formatToParts(new Date(ms))
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  }
}

/** Смещение пояса в момент, мс: местное время минус UTC. */
function offset(ms: number, timezone: string): number {
  const p = localParts(ms, timezone)
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return local - (ms - (((ms % 1000) + 1000) % 1000))
}

/** Местное время в поясе → мс эпохи (переход на летнее время — по смещению после него). */
function zoned(local: number, timezone: string): number {
  const first = local - offset(local, timezone)
  const second = offset(first, timezone)
  return local - second
}

/** Начало местного дня в поясе, мс эпохи. */
export function dayStart(day: Day, timezone: string): number {
  return zoned(Date.UTC(day.year, day.month - 1, day.day), timezone)
}

/** Полночь UTC календарной даты — так дата лежит в тайле. */
export function dayUtc(day: Day): number {
  return Date.UTC(day.year, day.month - 1, day.day)
}

export function addDays(day: Day, days: number): Day {
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day + days))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

/** Местная дата момента в поясе. */
export function dayOf(ms: number, timezone: string): Day {
  const { year, month, day } = localParts(ms, timezone)
  return { year, month, day }
}

/** Значение условия → день или момент; время без пояса — местное время пояса. */
export function parseMoment(value: unknown, timezone: string): Moment | null {
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'instant', ms: value }
  if (typeof value !== 'string') return null
  const date = ISO_DATE.exec(value)
  if (date) {
    const day = { year: Number(date[1]), month: Number(date[2]), day: Number(date[3]) }
    return validDay(day) ? { kind: 'day', day } : null
  }
  const match = ISO_DATETIME.exec(value)
  if (!match) return null
  const day = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  if (!validDay(day) || Number(match[4]) > 23 || Number(match[5]) > 59) return null
  if (match[8]) {
    const ms = Date.parse(value.replace(' ', 'T'))
    return Number.isNaN(ms) ? null : { kind: 'instant', ms }
  }
  const fraction = match[7] ? Number(`0.${match[7]}`) * 1000 : 0
  const local = Date.UTC(
    day.year,
    day.month - 1,
    day.day,
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0),
  )
  return { kind: 'instant', ms: zoned(local, timezone) + Math.round(fraction) }
}

function validDay(day: Day): boolean {
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day))
  return (
    date.getUTCFullYear() === day.year &&
    date.getUTCMonth() === day.month - 1 &&
    date.getUTCDate() === day.day
  )
}

export type RelativeUnit = 'day' | 'week' | 'month' | 'quarter' | 'year'

/** Начало единицы, содержащей день (неделя — с понедельника), со сдвигом на n единиц. */
export function unitStart(day: Day, unit: RelativeUnit, shift: number): Day {
  switch (unit) {
    case 'day':
      return addDays(day, shift)
    case 'week': {
      const weekday = (new Date(dayUtc(day)).getUTCDay() + 6) % 7
      return addDays(day, shift * 7 - weekday)
    }
    case 'month':
      return monthStart(day.year, day.month - 1 + shift)
    case 'quarter':
      return monthStart(day.year, Math.floor((day.month - 1) / 3) * 3 + shift * 3)
    case 'year':
      return { year: day.year + shift, month: 1, day: 1 }
  }
}

function monthStart(year: number, monthIndex: number): Day {
  const date = new Date(Date.UTC(year, monthIndex, 1))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: 1 }
}

export function formatDay(day: Day): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${pad(day.year, 4)}-${pad(day.month)}-${pad(day.day)}`
}
