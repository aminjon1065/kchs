import type { PeriodBucket } from '@kchs/fields'

/**
 * Приведение значений результата запроса. Драйвер Postgres отдаёт numeric и
 * bigint строками, даты — строками ISO или Date: график принимает всё это.
 */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export function isDateOnly(value: unknown): value is string {
  return typeof value === 'string' && DATE_ONLY.test(value)
}

/** Момент времени в мс; дата без времени — полночь UTC. */
export function toInstant(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime()
  if (typeof value === 'string') {
    const t = Date.parse(isDateOnly(value) ? `${value}T00:00:00Z` : value)
    return Number.isNaN(t) ? null : t
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>()

/**
 * «Настенное» время: момент, у которого UTC-компоненты равны местным в поясе
 * платформы. Ось времени ECharts работает в UTC (`useUTC`), подписи и бакеты
 * тоже считаются в UTC — и совпадают с календарём пользователя, где бы ни был браузер.
 * Дата без времени календарная и не сдвигается.
 */
export function toWallClock(value: unknown, timezone?: string): number | null {
  const instant = toInstant(value)
  if (instant === null) return null
  if (isDateOnly(value) || !timezone || timezone === 'UTC') return instant
  let fmt = wallFormatters.get(timezone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    wallFormatters.set(timezone, fmt)
  }
  const parts: Record<string, number> = {}
  for (const p of fmt.formatToParts(new Date(instant))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value)
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

const DAY = 86_400_000

/**
 * Гранулярность ряда по настенным моментам: все первые числа квартала — квартал,
 * все полночи понедельников с шагом неделя — неделя, и т. д. null — моменты
 * непериодические (сырые отметки времени).
 */
export function detectBucket(times: readonly number[]): PeriodBucket | null {
  if (times.length === 0) return null
  const dates = times.map((t) => new Date(t))
  const all = (test: (d: Date) => boolean) => dates.every(test)
  if (
    !all((d) => d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0)
  ) {
    return null
  }
  if (!all((d) => d.getUTCHours() === 0)) return 'hour'
  if (all((d) => d.getUTCMonth() === 0 && d.getUTCDate() === 1)) return 'year'
  if (all((d) => d.getUTCDate() === 1)) {
    const quarterStarts = all((d) => d.getUTCMonth() % 3 === 0)
    const sorted = [...new Set(times)].sort((a, b) => a - b)
    let minGap = Number.POSITIVE_INFINITY
    for (let i = 1; i < sorted.length; i += 1) {
      minGap = Math.min(minGap, (sorted[i] as number) - (sorted[i - 1] as number))
    }
    // Ряд из одного месяца — месяц; квартал — только когда шаг не меньше квартала
    return quarterStarts && sorted.length > 1 && minGap >= 89 * DAY ? 'quarter' : 'month'
  }
  if (all((d) => d.getUTCDay() === 1)) {
    const sorted = [...new Set(times)].sort((a, b) => a - b)
    const weekly = sorted.every(
      (t, i) => i === 0 || (t - (sorted[i - 1] as number)) % (7 * DAY) === 0,
    )
    if (weekly && sorted.length > 1) return 'week'
  }
  return 'day'
}

/** Следующий период того же бакета (настенное время, UTC-компоненты). */
export function addBucket(time: number, bucket: PeriodBucket, step = 1): number {
  const d = new Date(time)
  switch (bucket) {
    case 'year':
      return Date.UTC(d.getUTCFullYear() + step, d.getUTCMonth(), d.getUTCDate())
    case 'quarter':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3 * step, d.getUTCDate())
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + step, d.getUTCDate())
    case 'week':
      return time + 7 * DAY * step
    case 'day':
      return time + DAY * step
    case 'hour':
      return time + 3_600_000 * step
  }
}

/** Тот же момент годом раньше: 29 февраля переходит на 28-е. */
export function previousYear(time: number): number {
  const d = new Date(time)
  const target = new Date(
    Date.UTC(
      d.getUTCFullYear() - 1,
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
    ),
  )
  if (target.getUTCMonth() !== d.getUTCMonth()) target.setUTCDate(0)
  return target.getTime()
}

/**
 * Полная последовательность периодов от min до max: пропущенный месяц на
 * категориальной оси виден как пропуск, а не исчезает. null — периодов больше
 * предела (такой ряд не достраиваем).
 */
export function periodSequence(
  min: number,
  max: number,
  bucket: PeriodBucket,
  limit = 1000,
): number[] | null {
  const out: number[] = []
  for (let t = min; t <= max; t = addBucket(t, bucket)) {
    out.push(t)
    if (out.length > limit) return null
  }
  return out
}
