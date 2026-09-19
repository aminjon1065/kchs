import type { BusinessDayKind } from '@kchs/contracts'

/**
 * Рабочие дни по производственному календарю — чистые функции над датами
 * `ГГГГ-ММ-ДД`: исключения календаря подаёт вызывающий (`kindOf`), правило
 * недели — понедельник–пятница.
 */
export type DayKindOf = (day: string) => BusinessDayKind | undefined

const DAY_MS = 86_400_000

/** Дата со сдвигом на `days` календарных дней. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

/** День недели: 0 — воскресенье, 6 — суббота. */
export function weekday(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay()
}

export function isWorkingDate(day: string, kindOf: DayKindOf): boolean {
  const kind = kindOf(day)
  if (kind === 'holiday' || kind === 'weekend') return false
  if (kind === 'work' || kind === 'short') return true
  const dow = weekday(day)
  return dow !== 0 && dow !== 6
}

/**
 * Сдвиг на `n` рабочих дней: `n > 0` — n-й рабочий день после `from`,
 * `n < 0` — n-й рабочий день до него, `n = 0` — сам `from`, если он рабочий,
 * иначе ближайший следующий рабочий. Срок «3 рабочих дня» от пятницы — среда.
 */
export function shiftWorkingDays(from: string, n: number, kindOf: DayKindOf): string {
  if (n === 0) {
    let day = from
    for (let guard = 0; !isWorkingDate(day, kindOf); guard++) {
      if (guard > 366) throw new Error('В календаре нет рабочих дней на год вперёд')
      day = addDays(day, 1)
    }
    return day
  }
  const step = n > 0 ? 1 : -1
  let left = Math.abs(n)
  let day = from
  for (let guard = 0; left > 0; guard++) {
    if (guard > 366 * 5 + Math.abs(n)) throw new Error('В календаре нет рабочих дней')
    day = addDays(day, step)
    if (isWorkingDate(day, kindOf)) left--
  }
  return day
}

/** Рабочих дней в промежутке `(from, to]`; для `to < from` — со знаком минус. */
export function countWorkingDays(from: string, to: string, kindOf: DayKindOf): number {
  if (from === to) return 0
  const forward = from < to
  let count = 0
  let day = from
  while (day !== to) {
    day = addDays(day, forward ? 1 : -1)
    if (forward ? isWorkingDate(day, kindOf) : isWorkingDate(addDays(day, 1), kindOf)) count++
  }
  return forward ? count : -count
}

// ─── Время в поясе установки ──────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>()

function wallFormatter(timezone: string): Intl.DateTimeFormat {
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

/** Настенное время пояса для момента — в миллисекундах «как будто UTC». */
function toWall(instant: number, timezone: string): number {
  const parts: Record<string, number> = {}
  for (const part of wallFormatter(timezone).formatToParts(new Date(instant))) {
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
    ) +
    (instant % 1000)
  )
}

/** Момент по настенному времени пояса (смещение уточняется на самом моменте). */
function fromWall(wall: number, timezone: string): Date {
  const offset = (at: number) => toWall(at, timezone) - at
  const guess = wall - offset(wall)
  return new Date(wall - offset(guess))
}

/** Календарная дата момента в поясе: `ГГГГ-ММ-ДД`. */
export function localDate(instant: Date, timezone: string): string {
  return new Date(toWall(instant.getTime(), timezone)).toISOString().slice(0, 10)
}

/** Конец дня `day` в поясе — последний миг срока «до конца дня». */
export function endOfLocalDay(day: string, timezone: string): Date {
  return fromWall(Date.parse(`${day}T23:59:59.999Z`), timezone)
}

/** Начало дня `day` в поясе. */
export function startOfLocalDay(day: string, timezone: string): Date {
  return fromWall(Date.parse(`${day}T00:00:00.000Z`), timezone)
}
