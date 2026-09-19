/**
 * Время календаря в поясе пользователя (профиль, а не браузер): сетки
 * раскладываются по его часам, моменты API переводятся туда и обратно.
 * Неоднозначное время осеннего перехода — раннее, несуществующее весеннего —
 * сдвигается вперёд (как у сервера).
 */

export const MINUTE_MS = 60_000
export const DAY_MS = 86_400_000

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

/** Показания часов пояса для момента — как миллисекунды UTC. */
function wallMs(instant: number, timezone: string): number {
  const parts: Record<string, number> = {}
  for (const part of formatter(timezone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  )
}

function instantFromWall(wall: number, timezone: string): number {
  const before = wall - (wallMs(wall - 12 * 3_600_000, timezone) - (wall - 12 * 3_600_000))
  const after = wall - (wallMs(wall + 12 * 3_600_000, timezone) - (wall + 12 * 3_600_000))
  const firstValid = wallMs(before, timezone) === wall
  const secondValid = wallMs(after, timezone) === wall
  if (firstValid && secondValid) return Math.min(before, after)
  if (firstValid) return before
  if (secondValid) return after
  return before
}

/** Дата и минута суток момента в поясе. */
export function wallOf(instant: number, timezone: string): { date: string; minute: number } {
  const wall = wallMs(instant, timezone)
  const date = new Date(wall).toISOString().slice(0, 10)
  return { date, minute: Math.round((wall - Date.parse(`${date}T00:00:00Z`)) / MINUTE_MS) }
}

/** Момент даты и минуты суток в поясе. */
export function instantAt(date: string, minute: number, timezone: string): number {
  return instantFromWall(Date.parse(`${date}T00:00:00Z`) + minute * MINUTE_MS, timezone)
}

export function todayIn(timezone: string, now = Date.now()): string {
  return wallOf(now, timezone).date
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

/** День недели: 0 — воскресенье. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}

export function startOfWeek(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7))
}

/** `чч:мм` → минуты. */
export function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)
  return (hours ?? 0) * 60 + (minutes ?? 0)
}

const pad = (value: number) => String(value).padStart(2, '0')

/** Минуты суток → `чч:мм`. */
export function clockText(minute: number): string {
  const normalized = ((Math.round(minute) % 1440) + 1440) % 1440
  return `${pad(Math.floor(normalized / 60))}:${pad(normalized % 60)}`
}
