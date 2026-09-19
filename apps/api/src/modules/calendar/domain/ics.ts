import ICAL from 'ical.js'
import { normalizeRule, type OccurrenceOverride, RecurrenceError } from './recurrence.js'
import {
  addDays,
  DAY_MS,
  instantFromWall,
  isValidTimezone,
  localDate,
  MINUTE_MS,
  startOfDate,
  wallMs,
} from './time.js'

/**
 * iCalendar (RFC 5545) для подписки и импорта (ADR-0081): сборка ленты —
 * своя (экранирование, свёртка строк по 75 байт, VTIMEZONE по переходам
 * пояса), разбор файла — библиотекой `ical.js`.
 */

// ─── Сборка ───────────────────────────────────────────────────────────────

export interface IcsOccurrenceChange {
  recurrenceId: number
  startsAt: number
  endsAt: number
  startDate: string | null
  /** Не включается. */
  endDate: string | null
  summary?: string
  location?: string | null
  description?: string | null
}

export interface IcsEvent {
  uid: string
  sequence: number
  stamp: number
  summary: string
  description: string | null
  location: string | null
  allDay: boolean
  startsAt: number
  endsAt: number
  startDate: string | null
  /** Не включается. */
  endDate: string | null
  timezone: string
  rrule: string | null
  exdates: string[]
  changes: IcsOccurrenceChange[]
  transparent: boolean
  /** Детали скрыты: только время («занято»). */
  private: boolean
  url: string | null
}

/** Экранирование текста значения (RFC 5545 §3.3.11). */
export function escapeText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

const encoder = new TextEncoder()

/** Свёртка строки: не больше 75 байт UTF-8, продолжение — с пробела. */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line
  const parts: string[] = []
  let current = ''
  let size = 0
  for (const char of line) {
    const length = encoder.encode(char).length
    const limit = parts.length === 0 ? 75 : 74
    if (size + length > limit) {
      parts.push(current)
      current = ''
      size = 0
    }
    current += char
    size += length
  }
  parts.push(current)
  return parts.join('\r\n ')
}

const pad = (value: number) => String(value).padStart(2, '0')

function utcStamp(instant: number): string {
  const date = new Date(instant)
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(
    date.getUTCHours(),
  )}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
}

const localStamp = (instant: number, timezone: string) =>
  utcStamp(wallMs(instant, timezone)).slice(0, -1)
const dateStamp = (date: string) => date.replaceAll('-', '')

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
}

const offsetMinutes = (instant: number, timezone: string) =>
  Math.round((wallMs(instant, timezone) - instant) / MINUTE_MS)

/**
 * VTIMEZONE по фактическим переходам пояса за годы ленты: у пояса без
 * летнего времени — одно смещение, иначе — точка на каждый переход.
 */
export function vtimezone(timezone: string, fromYear: number, toYear: number): string[] {
  const start = Date.UTC(fromYear, 0, 1, 12)
  const end = Date.UTC(toYear, 11, 31, 12)
  const initial = offsetMinutes(start, timezone)
  const transitions: Array<{ at: number; from: number; to: number }> = []
  let previous = initial
  for (let noon = start + DAY_MS; noon <= end; noon += DAY_MS) {
    const offset = offsetMinutes(noon, timezone)
    if (offset === previous) continue
    // Момент перехода между прошлым и этим полднем — до минуты
    let low = noon - DAY_MS
    let high = noon
    while (high - low > MINUTE_MS) {
      const middle = low + Math.floor((high - low) / 2 / MINUTE_MS) * MINUTE_MS
      if (offsetMinutes(middle, timezone) === previous) low = middle
      else high = middle
    }
    transitions.push({ at: high, from: previous, to: offset })
    previous = offset
  }
  const lines = ['BEGIN:VTIMEZONE', `TZID:${timezone}`]
  if (transitions.length === 0) {
    lines.push(
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      `TZOFFSETFROM:${offsetText(initial)}`,
      `TZOFFSETTO:${offsetText(initial)}`,
      'END:STANDARD',
    )
  } else {
    const standard = Math.min(...transitions.map((item) => Math.min(item.from, item.to)))
    for (const transition of transitions) {
      const kind = transition.to > standard ? 'DAYLIGHT' : 'STANDARD'
      // Начало смещения — по местным часам до перехода
      const local = utcStamp(transition.at + transition.from * MINUTE_MS).slice(0, -1)
      lines.push(
        `BEGIN:${kind}`,
        `DTSTART:${local}`,
        `TZOFFSETFROM:${offsetText(transition.from)}`,
        `TZOFFSETTO:${offsetText(transition.to)}`,
        `END:${kind}`,
      )
    }
  }
  lines.push('END:VTIMEZONE')
  return lines
}

/**
 * Свойство времени: дата у события на весь день, местное время с TZID у
 * повторяющегося (правило разворачивается в его поясе), иначе — UTC.
 */
function timeProperty(
  name: string,
  value: { instant: number; date: string | null },
  allDay: boolean,
  timezone: string | null,
): string {
  if (allDay && value.date) return `${name};VALUE=DATE:${dateStamp(value.date)}`
  if (timezone) return `${name};TZID=${timezone}:${localStamp(value.instant, timezone)}`
  return `${name}:${utcStamp(value.instant)}`
}

function eventLines(event: IcsEvent, busyLabel: string): string[] {
  const zone = event.rrule && !event.allDay ? event.timezone : null
  const common = [
    `UID:${event.uid}`,
    `DTSTAMP:${utcStamp(event.stamp)}`,
    `SEQUENCE:${event.sequence}`,
    `TRANSP:${event.transparent ? 'TRANSPARENT' : 'OPAQUE'}`,
    `CLASS:${event.private ? 'PRIVATE' : 'PUBLIC'}`,
  ]
  const details = (summary: string, description: string | null, location: string | null) =>
    event.private
      ? [`SUMMARY:${escapeText(busyLabel)}`]
      : [
          `SUMMARY:${escapeText(summary)}`,
          ...(description ? [`DESCRIPTION:${escapeText(description)}`] : []),
          ...(location ? [`LOCATION:${escapeText(location)}`] : []),
          ...(event.url ? [`URL:${event.url}`] : []),
        ]
  const lines = [
    'BEGIN:VEVENT',
    ...common,
    timeProperty('DTSTART', { instant: event.startsAt, date: event.startDate }, event.allDay, zone),
    timeProperty('DTEND', { instant: event.endsAt, date: event.endDate }, event.allDay, zone),
    ...(event.rrule ? [`RRULE:${event.rrule}`] : []),
    ...event.exdates.map((value) => {
      const instant = Date.parse(value)
      return event.allDay
        ? `EXDATE;VALUE=DATE:${dateStamp(localDate(instant, event.timezone))}`
        : timeProperty('EXDATE', { instant, date: null }, false, zone)
    }),
    ...details(event.summary, event.description, event.location),
    'END:VEVENT',
  ]
  for (const change of event.changes) {
    lines.push(
      'BEGIN:VEVENT',
      ...common,
      timeProperty(
        'RECURRENCE-ID',
        {
          instant: change.recurrenceId,
          date: event.allDay ? localDate(change.recurrenceId, event.timezone) : null,
        },
        event.allDay,
        zone,
      ),
      timeProperty(
        'DTSTART',
        { instant: change.startsAt, date: change.startDate },
        event.allDay,
        zone,
      ),
      timeProperty('DTEND', { instant: change.endsAt, date: change.endDate }, event.allDay, zone),
      ...details(
        change.summary ?? event.summary,
        change.description !== undefined ? change.description : event.description,
        change.location !== undefined ? change.location : event.location,
      ),
      'END:VEVENT',
    )
  }
  return lines
}

/** Лента календаря: VCALENDAR с поясами повторяющихся событий. CRLF, свёртка строк. */
export function buildCalendar(
  name: string,
  items: IcsEvent[],
  options: { busyLabel: string; now?: number },
): string {
  const now = options.now ?? Date.now()
  const year = new Date(now).getUTCFullYear()
  const zones = [
    ...new Set(items.filter((item) => item.rrule && !item.allDay).map((item) => item.timezone)),
  ].filter(isValidTimezone)
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//kchs//calendar//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    ...zones.flatMap((zone) => vtimezone(zone, year - 1, year + 2)),
    ...items.flatMap((item) => eventLines(item, options.busyLabel)),
    'END:VCALENDAR',
  ]
  return `${lines.map(foldLine).join('\r\n')}\r\n`
}

// ─── Разбор ───────────────────────────────────────────────────────────────

export interface ParsedEvent {
  uid: string
  summary: string
  description: string | null
  location: string | null
  allDay: boolean
  startsAt: number
  endsAt: number
  startDate: string | null
  /** Не включается. */
  endDate: string | null
  timezone: string
  rrule: string | null
  exdates: string[]
  overrides: Record<string, OccurrenceOverride>
  private: boolean
  transparent: boolean
  cancelled: boolean
  sequence: number
}

export interface ParseResult {
  events: ParsedEvent[]
  errors: Array<{ uid: string | null; message: string }>
}

/** Предел событий в одном файле или канале. */
const MAX_EVENTS = 5000

type IcalTime = InstanceType<typeof ICAL.Time>
type IcalComponent = InstanceType<typeof ICAL.Component>
type IcalProperty = InstanceType<typeof ICAL.Property>

interface TimeValue {
  time: IcalTime
  tzid: string | null
}

function dateOf(time: IcalTime): string {
  return `${time.year}-${pad(time.month)}-${pad(time.day)}`
}

function tzidOf(property: IcalProperty): string | null {
  const value = property.getParameter('tzid')
  return typeof value === 'string' && value.length > 0 ? value : null
}

function timeOfProperty(component: IcalComponent, name: string): TimeValue | null {
  const property = component.getFirstProperty(name)
  if (!property) return null
  const value = property.getFirstValue()
  return value instanceof ICAL.Time ? { time: value, tzid: tzidOf(property) } : null
}

/**
 * Момент значения DATE-TIME: UTC — как есть; пояс IANA — по нашим правилам;
 * пояс из VTIMEZONE файла (Windows-имена) — пересчётом `ical.js`; «плавающее»
 * время — в поясе календаря.
 */
function instantOf(
  value: TimeValue,
  fallbackZone: string,
): { instant: number; zone: string | null } {
  const { time, tzid } = value
  const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second)
  if (time.zone === ICAL.Timezone.utcTimezone) return { instant: wall, zone: null }
  if (tzid && isValidTimezone(tzid)) return { instant: instantFromWall(wall, tzid), zone: tzid }
  if (tzid && ICAL.TimezoneService.has(tzid)) {
    return { instant: time.toJSDate().getTime(), zone: null }
  }
  return { instant: instantFromWall(wall, fallbackZone), zone: fallbackZone }
}

function textOf(component: IcalComponent, name: string): string | null {
  const value = component.getFirstPropertyValue(name)
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

/** Разбор `.ics`: события с повторами, исключениями и правками экземпляров. */
export function parseCalendar(text: string, fallbackZone: string): ParseResult {
  const errors: ParseResult['errors'] = []
  let root: IcalComponent
  try {
    root = new ICAL.Component(ICAL.parse(text) as never)
  } catch {
    return { events: [], errors: [{ uid: null, message: 'Файл не является календарём iCalendar' }] }
  }
  const calendar = root.name === 'vcalendar' ? root : root.getFirstSubcomponent('vcalendar')
  if (!calendar) {
    return { events: [], errors: [{ uid: null, message: 'Файл не является календарём iCalendar' }] }
  }
  for (const zone of calendar.getAllSubcomponents('vtimezone')) {
    try {
      const timezone = new ICAL.Timezone(zone)
      if (timezone.tzid && !ICAL.TimezoneService.has(timezone.tzid)) {
        ICAL.TimezoneService.register(timezone)
      }
    } catch {
      // Описание пояса не разобрано: времена с ним читаются как «плавающие»
    }
  }

  const masters = new Map<string, IcalComponent>()
  const changes = new Map<string, IcalComponent[]>()
  for (const component of calendar.getAllSubcomponents('vevent').slice(0, MAX_EVENTS)) {
    const uid = textOf(component, 'uid')
    if (!uid) {
      errors.push({ uid: null, message: 'Событие без UID пропущено' })
      continue
    }
    if (component.getFirstProperty('recurrence-id')) {
      changes.set(uid, [...(changes.get(uid) ?? []), component])
    } else {
      masters.set(uid, component)
    }
  }

  const events: ParsedEvent[] = []
  for (const [uid, component] of masters) {
    try {
      events.push(parseEvent(uid, component, changes.get(uid) ?? [], fallbackZone, errors))
    } catch (error) {
      errors.push({ uid, message: error instanceof Error ? error.message : 'Событие не разобрано' })
    }
  }
  return { events, errors: errors.slice(0, 50) }
}

function parseEvent(
  uid: string,
  component: IcalComponent,
  exceptions: IcalComponent[],
  fallbackZone: string,
  errors: ParseResult['errors'],
): ParsedEvent {
  const start = timeOfProperty(component, 'dtstart')
  if (!start) throw new Error('Нет времени начала (DTSTART)')
  const allDay = start.time.isDate
  const end = timeOfProperty(component, 'dtend')
  const duration = component.getFirstPropertyValue('duration')
  const durationSeconds = duration instanceof ICAL.Duration ? duration.toSeconds() : null

  let startsAt: number
  let endsAt: number
  let startDate: string | null = null
  let endDate: string | null = null
  let timezone = fallbackZone
  if (allDay) {
    startDate = dateOf(start.time)
    endDate = end?.time.isDate
      ? dateOf(end.time)
      : durationSeconds !== null
        ? addDays(startDate, Math.max(1, Math.round(durationSeconds / 86_400)))
        : addDays(startDate, 1)
    if (endDate <= startDate) endDate = addDays(startDate, 1)
    startsAt = startOfDate(startDate, timezone)
    endsAt = startOfDate(endDate, timezone)
  } else {
    const first = instantOf(start, fallbackZone)
    timezone = first.zone ?? fallbackZone
    startsAt = first.instant
    endsAt = end
      ? instantOf(end, fallbackZone).instant
      : durationSeconds !== null
        ? startsAt + durationSeconds * 1000
        : startsAt
    // Нулевая длительность (событие-метка) — полчаса, чтобы его было видно
    if (endsAt <= startsAt) endsAt = startsAt + 30 * MINUTE_MS
    if (endsAt - startsAt > 14 * DAY_MS) endsAt = startsAt + 14 * DAY_MS
  }
  const time = { allDay, startsAt, endsAt, startDate, endDate, timezone }

  let rrule: string | null = null
  const recur = component.getFirstPropertyValue('rrule')
  if (recur instanceof ICAL.Recur) {
    try {
      rrule = normalizeRule(recur.toString(), time)
    } catch (error) {
      const reason = error instanceof RecurrenceError ? error.message : 'правило не разобрано'
      errors.push({ uid, message: `Повтор не поддерживается (${reason}): загружен один раз` })
    }
  }

  const occurrenceStart = (value: TimeValue): number =>
    value.time.isDate
      ? startOfDate(dateOf(value.time), timezone)
      : instantOf(value, timezone).instant

  const exdates = new Set<string>()
  for (const property of component.getAllProperties('exdate')) {
    const tzid = tzidOf(property)
    for (const value of property.getValues()) {
      if (value instanceof ICAL.Time) {
        exdates.add(new Date(occurrenceStart({ time: value, tzid })).toISOString())
      }
    }
  }

  const overrides: Record<string, OccurrenceOverride> = {}
  for (const exception of exceptions) {
    const recurrence = timeOfProperty(exception, 'recurrence-id')
    if (!recurrence) continue
    const key = new Date(occurrenceStart(recurrence)).toISOString()
    if (String(exception.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED') {
      exdates.add(key)
      continue
    }
    const change: OccurrenceOverride = {}
    const changeStart = timeOfProperty(exception, 'dtstart')
    const changeEnd = timeOfProperty(exception, 'dtend')
    if (changeStart) {
      if (allDay) {
        change.startDate = dateOf(changeStart.time)
        change.endDate = changeEnd?.time.isDate
          ? dateOf(changeEnd.time)
          : addDays(change.startDate, 1)
      } else {
        const moved = instantOf(changeStart, timezone).instant
        change.startsAt = new Date(moved).toISOString()
        change.endsAt = new Date(
          changeEnd ? instantOf(changeEnd, timezone).instant : moved + (endsAt - startsAt),
        ).toISOString()
      }
    }
    const summary = textOf(exception, 'summary')
    if (summary) change.title = summary.slice(0, 500)
    const location = textOf(exception, 'location')
    if (location !== null) change.location = location.slice(0, 500)
    const description = textOf(exception, 'description')
    if (description !== null) change.description = description.slice(0, 20_000)
    overrides[key] = change
  }

  const klass = String(component.getFirstPropertyValue('class') ?? '').toUpperCase()
  const transp = String(component.getFirstPropertyValue('transp') ?? '').toUpperCase()
  const status = String(component.getFirstPropertyValue('status') ?? '').toUpperCase()
  const sequence = Number(component.getFirstPropertyValue('sequence') ?? 0)
  return {
    uid: uid.slice(0, 500),
    summary: (textOf(component, 'summary') ?? '—').slice(0, 500),
    description: textOf(component, 'description')?.slice(0, 20_000) ?? null,
    location: textOf(component, 'location')?.slice(0, 500) ?? null,
    ...time,
    rrule,
    exdates: rrule ? [...exdates] : [],
    overrides: rrule ? overrides : {},
    private: klass === 'PRIVATE' || klass === 'CONFIDENTIAL',
    transparent: allDay ? transp !== 'OPAQUE' : transp === 'TRANSPARENT',
    cancelled: status === 'CANCELLED',
    sequence: Number.isFinite(sequence) ? sequence : 0,
  }
}
