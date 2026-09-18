/**
 * Диапазоны дат для фильтров (contracts/field-types.md, оператор `relative`):
 * «последние 12 месяцев», «текущая неделя», «вчера» — в часовом поясе
 * пользователя. Используются списками объектов и компилятором запросов.
 * Полуинтервал [from, to): верхняя граница не включается.
 */

export type RangeUnit = 'day' | 'week' | 'month' | 'quarter' | 'year'

export interface RelativeRangeInput {
  unit: RangeUnit
  /** Смещение начала относительно текущего периода: -11 — «11 периодов назад». */
  from: number
  /** Смещение последнего включаемого периода: 0 — текущий. */
  to: number
}

export interface DateRange {
  from: Date
  to: Date
}

/** Календарные части момента в часовом поясе. */
function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  }
}

/** Смещение часового пояса в миллисекундах для момента `date`. */
function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

/** Полночь календарной даты в часовом поясе как момент UTC. */
export function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(year, month - 1, day))
  // Двух итераций достаточно и на переходах летнего времени
  let result = new Date(guess.getTime() - offsetMs(guess, timeZone))
  result = new Date(guess.getTime() - offsetMs(result, timeZone))
  return result
}

function addCalendar(
  y: number,
  m: number,
  d: number,
  unit: RangeUnit,
  amount: number,
): [number, number, number] {
  if (unit === 'day' || unit === 'week') {
    const date = new Date(Date.UTC(y, m - 1, d + amount * (unit === 'week' ? 7 : 1)))
    return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
  }
  const months = unit === 'month' ? amount : unit === 'quarter' ? amount * 3 : amount * 12
  const date = new Date(Date.UTC(y, m - 1 + months, 1))
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, 1]
}

/** Начало периода, в который попадает `now` (неделя — с понедельника). */
function periodStart(now: Date, unit: RangeUnit, timeZone: string): [number, number, number] {
  const p = zonedParts(now, timeZone)
  switch (unit) {
    case 'day':
      return [p.year, p.month, p.day]
    case 'week': {
      const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
      const mondayShift = (weekday + 6) % 7
      return addCalendar(p.year, p.month, p.day, 'day', -mondayShift)
    }
    case 'month':
      return [p.year, p.month, 1]
    case 'quarter':
      return [p.year, Math.floor((p.month - 1) / 3) * 3 + 1, 1]
    case 'year':
      return [p.year, 1, 1]
  }
}

export function relativeRange(
  input: RelativeRangeInput,
  now: Date = new Date(),
  timeZone = 'Asia/Dushanbe',
): DateRange {
  const [y, m, d] = periodStart(now, input.unit, timeZone)
  const fromDate = addCalendar(y, m, d, input.unit, Math.min(input.from, input.to))
  const toDate = addCalendar(y, m, d, input.unit, Math.max(input.from, input.to) + 1)
  return {
    from: zonedMidnight(...fromDate, timeZone),
    to: zonedMidnight(...toDate, timeZone),
  }
}

/** Календарный день значения в часовом поясе — для оператора `eq` над датами. */
export function dayRange(value: Date, timeZone = 'Asia/Dushanbe'): DateRange {
  const p = zonedParts(value, timeZone)
  const [ny, nm, nd] = addCalendar(p.year, p.month, p.day, 'day', 1)
  return {
    from: zonedMidnight(p.year, p.month, p.day, timeZone),
    to: zonedMidnight(ny, nm, nd, timeZone),
  }
}
