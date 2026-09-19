/**
 * Время в часовых поясах для календаря — чистые функции над миллисекундами.
 * «Настенное» время пояса — его показания часов, записанные как момент UTC:
 * так правило повтора разворачивается в местном времени (встреча в 10:00
 * остаётся в 10:00 и после перехода на летнее время).
 */

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

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

/** Известен ли пояс среде выполнения. */
export function isValidTimezone(timezone: string): boolean {
  try {
    formatter(timezone)
    return true
  } catch {
    return false
  }
}

/** Настенное время пояса для момента. */
export function wallMs(instant: number, timezone: string): number {
  const parts: Record<string, number> = {}
  for (const part of formatter(timezone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  const whole = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  )
  return whole + (((instant % 1000) + 1000) % 1000)
}

function offsetAt(instant: number, timezone: string): number {
  return wallMs(instant, timezone) - instant
}

/**
 * Момент по настенному времени пояса. Неоднозначное время (осенний переход)
 * — более раннее из двух; несуществующее (весенний переход) — сдвигается
 * вперёд на величину перехода, как `Temporal` с `disambiguation: 'compatible'`.
 */
export function instantFromWall(wall: number, timezone: string): number {
  const before = offsetAt(wall - 12 * HOUR_MS, timezone)
  const after = offsetAt(wall + 12 * HOUR_MS, timezone)
  const first = wall - before
  const second = wall - after
  const firstValid = wallMs(first, timezone) === wall
  const secondValid = wallMs(second, timezone) === wall
  if (firstValid && secondValid) return Math.min(first, second)
  if (firstValid) return first
  if (secondValid) return second
  return first
}

/** Календарная дата момента в поясе: `ГГГГ-ММ-ДД`. */
export function localDate(instant: number, timezone: string): string {
  return new Date(wallMs(instant, timezone)).toISOString().slice(0, 10)
}

/** Настенное время начала даты. */
export function dateWall(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`)
}

/** Дата настенного времени. */
export function wallDate(wall: number): string {
  return new Date(wall).toISOString().slice(0, 10)
}

export function addDays(date: string, days: number): string {
  return wallDate(dateWall(date) + days * DAY_MS)
}

/** Число суток между датами (`to - from`). */
export function daysBetween(from: string, to: string): number {
  return Math.round((dateWall(to) - dateWall(from)) / DAY_MS)
}

/** Начало даты в поясе — момент полуночи. */
export function startOfDate(date: string, timezone: string): number {
  return instantFromWall(dateWall(date), timezone)
}

/** `чч:мм` → минуты от полуночи. */
export function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)
  return (hours ?? 0) * 60 + (minutes ?? 0)
}

/** Момент даты и времени суток в поясе. */
export function instantAt(date: string, minutes: number, timezone: string): number {
  return instantFromWall(dateWall(date) + minutes * MINUTE_MS, timezone)
}

export const iso = (instant: number): string => new Date(instant).toISOString()
