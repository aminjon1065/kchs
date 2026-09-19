import * as rruleModule from 'rrule'
import {
  addDays,
  DAY_MS,
  dateWall,
  daysBetween,
  instantFromWall,
  iso,
  localDate,
  startOfDate,
  wallDate,
  wallMs,
} from './time.js'

// Сборка UMD пакета `rrule`: в Node ESM именованные экспорты лежат в default,
// в сборке esbuild и в vitest — в самом модуле
const lib = ((rruleModule as unknown as { default?: typeof rruleModule }).default ??
  rruleModule) as typeof rruleModule
const { RRule } = lib
type RRuleInstance = InstanceType<typeof RRule>

/**
 * Повторы событий (RFC 5545 RRULE, ADR-0081). Правило разворачивается в
 * настенном времени пояса события и переводится в моменты: встреча в 10:00
 * остаётся в 10:00 по местным часам и после перехода на летнее время. События
 * на весь день повторяются датами.
 */

/** Предел экземпляров одной серии при материализации. */
export const MAX_OCCURRENCES = 3000
/** Горизонт материализации бесконечных серий — два года. */
export const HORIZON_MS = 731 * DAY_MS

/** Ошибка правила повтора: текст — для пользователя. */
export class RecurrenceError extends Error {}

/** Правка отдельного экземпляра; даты события на весь день — `endDate` не включается. */
export interface OccurrenceOverride {
  startsAt?: string
  endsAt?: string
  startDate?: string
  endDate?: string
  title?: string
  location?: string | null
  description?: string | null
}

/** Время первого экземпляра. У события на весь день `endDate` не включается. */
export interface SeriesTime {
  allDay: boolean
  startsAt: number
  endsAt: number
  startDate: string | null
  endDate: string | null
  timezone: string
}

export interface Series extends SeriesTime {
  rrule: string | null
  /** Исходные начала отменённых экземпляров (ISO). */
  exdates: readonly string[]
  overrides: Readonly<Record<string, OccurrenceOverride>>
}

export interface Occurrence {
  /** Исходное начало (RECURRENCE-ID). */
  recurrenceId: number
  startsAt: number
  endsAt: number
  startDate: string | null
  /** Не включается. */
  endDate: string | null
  overridden: boolean
}

const ALLOWED_KEYS = new Set([
  'FREQ',
  'INTERVAL',
  'COUNT',
  'UNTIL',
  'BYDAY',
  'BYMONTHDAY',
  'BYMONTH',
  'BYSETPOS',
  'BYYEARDAY',
  'BYWEEKNO',
  'WKST',
])
const ALLOWED_FREQ = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])

interface RuleParts {
  keys: string[]
  values: Map<string, string>
}

function parts(rule: string): RuleParts {
  const body = rule.trim().replace(/^RRULE:/i, '')
  const keys: string[] = []
  const values = new Map<string, string>()
  for (const chunk of body.split(';')) {
    if (!chunk) continue
    const [rawKey, ...rest] = chunk.split('=')
    const key = (rawKey ?? '').trim().toUpperCase()
    const value = rest.join('=').trim().toUpperCase()
    if (!key || !value) throw new RecurrenceError('Правило повтора записано неверно')
    if (values.has(key)) throw new RecurrenceError(`Часть ${key} повторяется`)
    keys.push(key)
    values.set(key, value)
  }
  return { keys, values }
}

/** Порядок частей в сохранённом правиле: одинаковые правила — одинаковые строки. */
const KEY_ORDER = [
  'FREQ',
  'INTERVAL',
  'BYMONTH',
  'BYWEEKNO',
  'BYYEARDAY',
  'BYMONTHDAY',
  'BYDAY',
  'BYSETPOS',
  'WKST',
  'COUNT',
  'UNTIL',
]

function serialize({ keys, values }: RuleParts): string {
  const ordered = [
    ...KEY_ORDER.filter((key) => values.has(key)),
    ...keys.filter((key) => !KEY_ORDER.includes(key) && values.has(key)),
  ]
  return ordered.map((key) => `${key}=${values.get(key)}`).join(';')
}

const UNTIL_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/

/** UNTIL: момент (UTC или местное время пояса) или дата. */
function parseUntil(
  value: string,
  timezone: string,
): { date: string; instant: number | null; floating: boolean } {
  const match = UNTIL_RE.exec(value)
  if (!match) throw new RecurrenceError('Дата окончания повтора записана неверно')
  const [, y, m, d, hh, mm, ss, z] = match
  const date = `${y}-${m}-${d}`
  if (hh === undefined) return { date, instant: null, floating: false }
  const wall = Date.parse(`${date}T${hh}:${mm}:${ss}.000Z`)
  return z
    ? { date, instant: wall, floating: false }
    : { date, instant: instantFromWall(wall, timezone), floating: true }
}

const compactDate = (date: string) => date.replaceAll('-', '')
const compactInstant = (instant: number) => `${iso(instant).slice(0, 19).replace(/[-:]/g, '')}Z`

/**
 * Проверка и нормализация правила: частота не чаще раза в день, без COUNT и
 * UNTIL одновременно; UNTIL — момент UTC у событий со временем и дата у
 * событий на весь день. Правило должно давать хотя бы один экземпляр.
 */
export function normalizeRule(raw: string, time: SeriesTime): string {
  const rule = parts(raw)
  for (const key of rule.keys) {
    if (!ALLOWED_KEYS.has(key)) throw new RecurrenceError(`Часть ${key} не поддерживается`)
  }
  const freq = rule.values.get('FREQ')
  if (!freq || !ALLOWED_FREQ.has(freq)) {
    throw new RecurrenceError('Повтор — ежедневно, еженедельно, ежемесячно или ежегодно')
  }
  if (rule.values.has('COUNT') && rule.values.has('UNTIL')) {
    throw new RecurrenceError('Укажите либо число повторений, либо дату окончания')
  }
  const count = rule.values.get('COUNT')
  if (count !== undefined && !(/^\d+$/.test(count) && +count >= 1 && +count <= 1000)) {
    throw new RecurrenceError('Число повторений — от 1 до 1000')
  }
  const interval = rule.values.get('INTERVAL')
  if (interval !== undefined && !(/^\d+$/.test(interval) && +interval >= 1 && +interval <= 999)) {
    throw new RecurrenceError('Интервал повтора — от 1 до 999')
  }
  const until = rule.values.get('UNTIL')
  if (until !== undefined) {
    const parsed = parseUntil(until, time.timezone)
    if (time.allDay) {
      const date = parsed.instant !== null ? localDate(parsed.instant, time.timezone) : parsed.date
      rule.values.set('UNTIL', compactDate(date))
    } else {
      // Дата без времени — до конца этого дня в поясе события
      const instant =
        parsed.instant ?? instantFromWall(dateWall(parsed.date) + DAY_MS - 1000, time.timezone)
      rule.values.set('UNTIL', compactInstant(instant))
    }
  }
  const normalized = serialize(rule)
  try {
    RRule.parseString(normalized)
  } catch {
    throw new RecurrenceError('Правило повтора записано неверно')
  }
  const probe = expandSeries(
    { ...time, rrule: normalized, exdates: [], overrides: {} },
    time.startsAt + HORIZON_MS,
    2,
  )
  if (probe.occurrences.length === 0) throw new RecurrenceError('Правило не даёт ни одного повтора')
  return normalized
}

/** Правило в настенном времени пояса для библиотеки `rrule`. */
function ruleFor(series: Series): RRuleInstance {
  const rule = parts(series.rrule ?? '')
  const until = rule.values.get('UNTIL')
  rule.values.delete('UNTIL')
  const options = RRule.parseString(serialize(rule))
  options.dtstart = new Date(firstWall(series))
  options.tzid = null
  if (until !== undefined) {
    const parsed = parseUntil(until, series.timezone)
    if (series.allDay) {
      const date =
        parsed.instant !== null ? localDate(parsed.instant, series.timezone) : parsed.date
      options.until = new Date(dateWall(date))
    } else {
      options.until = new Date(
        parsed.instant !== null
          ? wallMs(parsed.instant, series.timezone)
          : dateWall(parsed.date) + DAY_MS - 1000,
      )
    }
  }
  return new RRule(options)
}

function firstWall(series: SeriesTime): number {
  return series.allDay && series.startDate
    ? dateWall(series.startDate)
    : wallMs(series.startsAt, series.timezone)
}

/** Экземпляр по настенному времени начала — с исключениями и правками. */
function occurrenceAt(series: Series, wall: number): Occurrence {
  if (series.allDay && series.startDate && series.endDate) {
    const span = Math.max(1, daysBetween(series.startDate, series.endDate))
    const date = wallDate(wall)
    const recurrenceId = startOfDate(date, series.timezone)
    const endDate = addDays(date, span)
    return {
      recurrenceId,
      startsAt: recurrenceId,
      endsAt: startOfDate(endDate, series.timezone),
      startDate: date,
      endDate,
      overridden: false,
    }
  }
  const recurrenceId = instantFromWall(wall, series.timezone)
  return {
    recurrenceId,
    startsAt: recurrenceId,
    endsAt: recurrenceId + (series.endsAt - series.startsAt),
    startDate: null,
    endDate: null,
    overridden: false,
  }
}

function applyOverride(series: Series, occurrence: Occurrence): Occurrence {
  const change = series.overrides[iso(occurrence.recurrenceId)]
  if (!change) return occurrence
  if (series.allDay) {
    const startDate = change.startDate ?? occurrence.startDate
    const endDate = change.endDate ?? occurrence.endDate
    if (!startDate || !endDate) return { ...occurrence, overridden: true }
    return {
      ...occurrence,
      startDate,
      endDate,
      startsAt: startOfDate(startDate, series.timezone),
      endsAt: startOfDate(endDate, series.timezone),
      overridden: true,
    }
  }
  return {
    ...occurrence,
    startsAt: change.startsAt ? Date.parse(change.startsAt) : occurrence.startsAt,
    endsAt: change.endsAt ? Date.parse(change.endsAt) : occurrence.endsAt,
    overridden: true,
  }
}

/**
 * Экземпляры серии от начала (или от момента `from`) до момента `until` — не
 * больше `limit`. `complete` — после `until` повторов нет (серия конечна и
 * развёрнута целиком). Первый экземпляр — всегда само начало события, даже
 * если оно не попадает в шаблон правила.
 */
export function expandSeries(
  series: Series,
  until: number,
  limit = MAX_OCCURRENCES,
  from?: number,
): { occurrences: Occurrence[]; complete: boolean } {
  const excluded = new Set(series.exdates.map((value) => Date.parse(value)))
  if (!series.rrule) {
    const single = occurrenceAt(series, firstWall(series))
    return {
      occurrences: excluded.has(single.recurrenceId) ? [] : [applyOverride(series, single)],
      complete: true,
    }
  }
  const rule = ruleFor(series)
  const start = firstWall(series)
  const toWall = (instant: number) =>
    series.allDay ? dateWall(localDate(instant, series.timezone)) : wallMs(instant, series.timezone)
  const fromWall = from === undefined ? start : Math.max(start, toWall(from))
  const untilWall = Math.max(fromWall, toWall(until))
  const walls: number[] = []
  let truncated = false
  rule.between(new Date(fromWall), new Date(untilWall), true, (date) => {
    if (walls.length >= limit) {
      truncated = true
      return false
    }
    walls.push(date.getTime())
    return true
  })
  if (fromWall === start && walls[0] !== start && walls.length < limit) walls.unshift(start)
  if (walls.length > limit) walls.length = limit

  const occurrences: Occurrence[] = []
  for (const wall of walls) {
    const occurrence = occurrenceAt(series, wall)
    if (excluded.has(occurrence.recurrenceId)) continue
    occurrences.push(applyOverride(series, occurrence))
  }
  const complete = !truncated && rule.after(new Date(untilWall), false) === null
  return { occurrences, complete }
}

/**
 * Экземпляр серии по исходному началу — с правкой (`withOverride`) или
 * исходный; `null` — такого экземпляра нет или он отменён.
 */
export function occurrenceOf(
  series: Series,
  recurrenceId: number,
  withOverride = true,
): Occurrence | null {
  if (!hasOccurrence(series, recurrenceId)) return null
  if (series.exdates.some((key) => Date.parse(key) === recurrenceId)) return null
  const wall = series.allDay
    ? dateWall(localDate(recurrenceId, series.timezone))
    : wallMs(recurrenceId, series.timezone)
  const occurrence = occurrenceAt(series, wall)
  return withOverride ? applyOverride(series, occurrence) : occurrence
}

/** Есть ли у серии экземпляр с этим исходным началом (исключённые — тоже считаются). */
export function hasOccurrence(series: Series, recurrenceId: number): boolean {
  const first = occurrenceAt(series, firstWall(series))
  if (first.recurrenceId === recurrenceId) return true
  if (!series.rrule) return false
  const wall = series.allDay
    ? dateWall(localDate(recurrenceId, series.timezone))
    : wallMs(recurrenceId, series.timezone)
  const found = ruleFor(series).between(new Date(wall), new Date(wall), true)
  return found.some((date) => occurrenceAt(series, date.getTime()).recurrenceId === recurrenceId)
}

/**
 * Правило серии, оборванное перед экземпляром («это и следующие»): UNTIL —
 * за секунду до его начала (у событий на весь день — предыдущий день), COUNT
 * снимается. `null` — до экземпляра повторов нет.
 */
export function truncateBefore(series: Series, recurrenceId: number): string | null {
  if (!series.rrule) return null
  const first = occurrenceAt(series, firstWall(series))
  if (recurrenceId <= first.recurrenceId) return null
  const rule = parts(series.rrule)
  rule.values.delete('COUNT')
  rule.keys = rule.keys.filter((key) => key !== 'COUNT')
  if (!rule.keys.includes('UNTIL')) rule.keys.push('UNTIL')
  rule.values.set(
    'UNTIL',
    series.allDay
      ? compactDate(addDays(localDate(recurrenceId, series.timezone), -1))
      : compactInstant(recurrenceId - 1000),
  )
  return serialize(rule)
}

/**
 * Правило продолжения серии с экземпляра: у правила с COUNT — оставшееся число
 * повторений, иначе прежнее правило.
 */
export function tailRule(series: Series, recurrenceId: number): string | null {
  if (!series.rrule) return null
  const rule = parts(series.rrule)
  const count = rule.values.get('COUNT')
  if (count === undefined) return series.rrule
  const before = expandSeries(
    { ...series, exdates: [], overrides: {} },
    recurrenceId - 1,
    MAX_OCCURRENCES,
  ).occurrences.filter((occurrence) => occurrence.recurrenceId < recurrenceId).length
  rule.values.set('COUNT', String(Math.max(1, Number(count) - before)))
  return serialize(rule)
}

/**
 * Перенос исключений и правок вслед за началом серии: сдвиг настенного
 * времени (или дней у событий на весь день) такой же, как у первого
 * экземпляра. Смена «весь день ↔ время» их сбрасывает.
 */
export function shiftSeriesKeys(
  series: Series,
  next: SeriesTime,
): { exdates: string[]; overrides: Record<string, OccurrenceOverride> } {
  if (series.allDay !== next.allDay) return { exdates: [], overrides: {} }
  const shift = (key: string): string => {
    const instant = Date.parse(key)
    if (series.allDay && series.startDate && next.startDate) {
      const days = daysBetween(series.startDate, next.startDate)
      return iso(startOfDate(addDays(localDate(instant, series.timezone), days), next.timezone))
    }
    const delta = wallMs(next.startsAt, next.timezone) - wallMs(series.startsAt, series.timezone)
    return iso(instantFromWall(wallMs(instant, series.timezone) + delta, next.timezone))
  }
  const overrides: Record<string, OccurrenceOverride> = {}
  for (const [key, value] of Object.entries(series.overrides)) overrides[shift(key)] = value
  return { exdates: series.exdates.map(shift), overrides }
}
