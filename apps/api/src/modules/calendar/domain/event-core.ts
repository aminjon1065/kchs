import type { AttendeeStatus, CalendarColor, EventVisibility, Reminder } from '@kchs/contracts'
import { and, eq, sql } from 'drizzle-orm'
import { grantAccess } from '~/kernel/access/acl-service.js'
import { authorize, loadObject } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import type { EventInput } from '~/kernel/events/types.js'
import { LinkService } from '~/kernel/links/service.js'
import { objects } from '~/kernel/objects/schema.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { config } from '~/shared/config/index.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import type { Executor, Tx } from '~/shared/db/client.js'
import { AppError, errors } from '~/shared/errors.js'
import {
  eventAttendees,
  eventInstances,
  eventResources,
  events,
  type ReminderValue,
} from '../schema.js'
import {
  type CalendarRow,
  CalendarService,
  loadCalendar,
  principalUser,
} from './calendar-service.js'
import { type EventRow, materialize } from './instances.js'
import {
  normalizeRule,
  type Occurrence,
  type OccurrenceOverride,
  RecurrenceError,
  type SeriesTime,
} from './recurrence.js'
import { addDays, DAY_MS, iso, localDate, startOfDate } from './time.js'

/**
 * Общее событий календаря (ADR-0081): чтение строки с участниками и ресурсами, время и
 * правило повторения из ввода, проверки участников, ресурсов и связей, вставка события
 * с экземплярами, приглашениями и напоминаниями.
 */

/** Право участника: видеть и обсуждать встречу (правят организатор и редакторы календаря). */
export const ATTENDEE_LEVEL = 'comment' as const
/** Самое длинное событие со временем — две недели; на весь день — год. */
const MAX_TIMED_MS = 14 * DAY_MS
const MAX_ALL_DAY_DAYS = 366

const COLUMNS = {
  event: events,
  title: objects.title,
  spaceId: objects.spaceId,
  ownerId: objects.ownerId,
  accessMode: objects.accessMode,
  version: objects.version,
  createdAt: objects.createdAt,
  updatedAt: objects.updatedAt,
}

export interface LoadedEvent {
  row: EventRow
  title: string
  spaceId: string | null
  ownerId: string | null
  accessMode: string
  version: number
  createdAt: string
  updatedAt: string
}

export async function loadEvent(
  executor: Executor,
  id: string,
  lock = false,
): Promise<LoadedEvent | null> {
  const query = executor
    .select(COLUMNS)
    .from(events)
    .innerJoin(objects, eq(objects.id, events.id))
    .where(and(eq(events.id, id), sql`${objects.deletedAt} IS NULL`))
    .limit(1)
  const [found] = lock ? await query.for('update', { of: events }) : await query
  if (!found) return null
  const { event, ...rest } = found
  return { row: event, ...rest }
}

interface AttendeeRow {
  userId: string
  role: string
  optional: boolean
  status: string
  comment: string | null
  proposal: { startsAt: string; endsAt: string; recurrenceId: string | null } | null
  respondedAt: string | null
  reminders: ReminderValue[] | null
}

export async function attendeesOf(executor: Executor, eventId: string): Promise<AttendeeRow[]> {
  return executor
    .select({
      userId: eventAttendees.userId,
      role: eventAttendees.role,
      optional: eventAttendees.optional,
      status: eventAttendees.status,
      comment: eventAttendees.comment,
      proposal: eventAttendees.proposal,
      respondedAt: eventAttendees.respondedAt,
      reminders: eventAttendees.reminders,
    })
    .from(eventAttendees)
    .where(eq(eventAttendees.eventId, eventId))
}

export async function resourceIdsOf(executor: Executor, eventId: string): Promise<string[]> {
  const rows = await executor
    .select({ id: eventResources.resourceId })
    .from(eventResources)
    .where(eq(eventResources.eventId, eventId))
  return rows.map((row) => row.id)
}

export function validation(path: string, message: string): never {
  throw errors.validation(message, [{ path, message }])
}

interface TimeInput {
  allDay?: boolean | undefined
  startsAt?: string | undefined
  endsAt?: string | undefined
  startDate?: string | undefined
  endDate?: string | undefined
}

/** Время события из ввода поверх текущего: даты у события на весь день, моменты — у остальных. */
export function timeOf(input: TimeInput, timezone: string, current: SeriesTime | null): SeriesTime {
  const allDay = input.allDay ?? current?.allDay ?? false
  if (allDay) {
    const currentStart = current
      ? (current.startDate ?? localDate(current.startsAt, current.timezone))
      : null
    const startDate = input.startDate ?? currentStart
    if (!startDate) validation('startDate', 'Укажите дату события')
    const currentLast =
      current?.allDay && current.endDate && !input.startDate
        ? addDays(current.endDate, -1)
        : startDate
    const lastDay = input.endDate ?? currentLast
    if (lastDay < startDate) validation('endDate', 'Окончание раньше начала')
    const endDate = addDays(lastDay, 1)
    if ((Date.parse(endDate) - Date.parse(startDate)) / DAY_MS > MAX_ALL_DAY_DAYS) {
      validation('endDate', 'Событие на весь день — не длиннее года')
    }
    return {
      allDay: true,
      startsAt: startOfDate(startDate, timezone),
      endsAt: startOfDate(endDate, timezone),
      startDate,
      endDate,
      timezone,
    }
  }
  const duration = current && !current.allDay ? current.endsAt - current.startsAt : 3_600_000
  const startsAt = input.startsAt
    ? Date.parse(input.startsAt)
    : current && !current.allDay
      ? current.startsAt
      : current
        ? current.startsAt + 9 * 3_600_000
        : Number.NaN
  if (Number.isNaN(startsAt)) validation('startsAt', 'Укажите время события')
  const endsAt = input.endsAt ? Date.parse(input.endsAt) : startsAt + duration
  if (endsAt <= startsAt) validation('endsAt', 'Окончание раньше начала')
  if (endsAt - startsAt > MAX_TIMED_MS) {
    validation('endsAt', 'Событие со временем — не длиннее двух недель')
  }
  return { allDay: false, startsAt, endsAt, startDate: null, endDate: null, timezone }
}

export function ruleOf(raw: string | null | undefined, time: SeriesTime): string | null {
  if (!raw) return null
  try {
    return normalizeRule(raw, time)
  } catch (error) {
    if (error instanceof RecurrenceError) validation('rrule', error.message)
    throw error
  }
}

export function sameTime(a: SeriesTime, b: SeriesTime): boolean {
  return (
    a.allDay === b.allDay &&
    a.startsAt === b.startsAt &&
    a.endsAt === b.endsAt &&
    a.startDate === b.startDate &&
    a.endDate === b.endDate &&
    a.timezone === b.timezone
  )
}

/** Сотрудники-участники существуют и не заблокированы. */
export async function assertPeople(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const refs = await directory().refs(ids)
  for (const id of ids) {
    const ref = refs.get(id)
    if (!ref) validation('attendees', 'Сотрудник не найден')
    if (ref.status === 'blocked' || ref.status === 'deactivated') {
      validation('attendees', `Сотрудник «${ref.displayName}» заблокирован`)
    }
  }
}

/** Ресурсы — ресурсные календари, которые пользователь может бронировать. */
export async function assertResources(tx: Executor, ctx: Ctx, ids: string[]): Promise<void> {
  for (const id of ids) {
    const resource = await loadCalendar(tx, id)
    if (resource?.kind !== 'resource') validation('resourceIds', 'Ресурс не найден')
    await authorize(ctx, 'book', id)
  }
}

/**
 * Ресурс не занят другими событиями на время будущих экземпляров. Занятость —
 * конфликт 409 с перечнем пересечений.
 */
export async function assertResourcesFree(
  tx: Executor,
  eventId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  const conflicts = await tx.execute<{
    resource_id: string
    starts_at: string | Date
    ends_at: string | Date
  }>(sql`
    SELECT DISTINCT r.resource_id, other.starts_at, other.ends_at
      FROM ${eventInstances} mine
      JOIN ${eventResources} r
        ON r.resource_id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
       AND r.event_id <> ${eventId} AND r.status = 'accepted'
      JOIN ${eventInstances} other
        ON other.event_id = r.event_id
       AND tstzrange(other.starts_at, other.ends_at, '[)') && tstzrange(mine.starts_at, mine.ends_at, '[)')
      JOIN ${objects} o ON o.id = r.event_id AND o.deleted_at IS NULL
     WHERE mine.event_id = ${eventId} AND mine.ends_at > now()
     ORDER BY other.starts_at
     LIMIT 5`)
  if (conflicts.length === 0) return
  // Пересечения — клиенту (`data`): форма покажет, когда ресурс занят
  throw new AppError('conflict', 'Ресурс занят в это время', 409, {
    data: {
      conflicts: conflicts.map((row) => ({
        resourceId: row.resource_id,
        startsAt: new Date(row.starts_at).toISOString(),
        endsAt: new Date(row.ends_at).toISOString(),
      })),
    },
  })
}

export function metaOf(row: {
  startsAt: string
  endsAt: string
  allDay: boolean
  rrule: string | null
  calendarId: string
  visibility: string
}): Record<string, unknown> {
  return {
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    allDay: row.allDay,
    recurring: Boolean(row.rrule),
    calendarId: row.calendarId,
    visibility: row.visibility,
  }
}

export async function emit(
  tx: Tx,
  ctx: Ctx,
  view: { id: string; spaceId: string | null; title: string },
  type: EventInput['type'],
  payload: Record<string, unknown>,
): Promise<void> {
  await publishEvent(tx, ctx, {
    type,
    object: { id: view.id, type: 'event', spaceId: view.spaceId, title: view.title },
    payload,
  })
}

/** Ближайший (или первый) экземпляр — срок приглашения и время в его тексте. */
export async function nextOccurrence(executor: Executor, row: EventRow) {
  const [next] = await executor
    .select({ startsAt: eventInstances.startsAt, startDate: eventInstances.startDate })
    .from(eventInstances)
    .where(and(eq(eventInstances.eventId, row.id), sql`${eventInstances.endsAt} > now()`))
    .orderBy(eventInstances.startsAt)
    .limit(1)
  return {
    id: row.id,
    startsAt: Date.parse(next?.startsAt ?? row.startsAt),
    allDay: row.allDay,
    startDate: next?.startDate ?? row.startDate,
  }
}

export interface EventSpec {
  calendar: CalendarRow
  title: string
  description: string | null
  location: string | null
  time: SeriesTime
  rrule: string | null
  exdates: string[]
  overrides: Record<string, OccurrenceOverride>
  visibility: EventVisibility
  transparency: 'opaque' | 'transparent'
  color: CalendarColor | null
  reminders: ReminderValue[]
  ownerId: string | null
  organizerId: string | null
  attendees: Array<{
    userId: string
    optional: boolean
    status?: AttendeeStatus
    respondedAt?: string | null
    comment?: string | null
  }>
  resourceIds: string[]
  linkedObjectIds: string[]
  uid?: string
  sequence?: number
  source: 'local' | 'import' | 'subscription'
  seriesId?: string | null
}

function uidHost(): string {
  try {
    return new URL(config().KCHS_BASE_URL).hostname || 'kchs'
  } catch {
    return 'kchs'
  }
}

/**
 * Запись события: объект реестра (дочерний календаря; закрытый для «занято» и
 * «личное»), строка события, участники с правом `comment`, ресурсы, связи и
 * экземпляры. События публикует вызывающий.
 */
export async function insertEvent(tx: Tx, ctx: Ctx, spec: EventSpec): Promise<EventRow> {
  const restricted = spec.visibility !== 'public'
  const startsAt = iso(spec.time.startsAt)
  const endsAt = iso(spec.time.endsAt)
  const object = await ObjectService.create(tx, ctx, {
    type: 'event',
    spaceId: spec.calendar.spaceId,
    parentId: spec.calendar.id,
    title: spec.title,
    ownerId: spec.ownerId,
    accessMode: restricted ? 'restricted' : 'inherit',
    meta: metaOf({
      startsAt,
      endsAt,
      allDay: spec.time.allDay,
      rrule: spec.rrule,
      calendarId: spec.calendar.id,
      visibility: spec.visibility,
    }),
  })
  const [row] = await tx
    .insert(events)
    .values({
      id: object.id,
      calendarId: spec.calendar.id,
      organizerId: spec.organizerId,
      startsAt,
      endsAt,
      allDay: spec.time.allDay,
      startDate: spec.time.startDate,
      endDate: spec.time.endDate,
      timezone: spec.time.timezone,
      rrule: spec.rrule,
      exdates: spec.exdates,
      overrides: spec.overrides,
      location: spec.location,
      description: spec.description,
      visibility: spec.visibility,
      transparency: spec.transparency,
      reminders: spec.reminders,
      linkedObjectIds: spec.linkedObjectIds,
      color: spec.color,
      uid: spec.uid ?? `${object.id}@${uidHost()}`,
      sequence: spec.sequence ?? 0,
      source: spec.source,
      seriesId: spec.seriesId ?? null,
    })
    .returning()
  if (!row) throw errors.internal('Событие не создано')

  const people = spec.attendees.filter((item) => item.userId !== spec.organizerId)
  const attendeeRows = [
    ...(spec.organizerId
      ? [
          {
            eventId: row.id,
            userId: spec.organizerId,
            role: 'organizer',
            optional: false,
            status: 'accepted',
            respondedAt: new Date().toISOString(),
          },
        ]
      : []),
    ...people.map((item) => ({
      eventId: row.id,
      userId: item.userId,
      role: 'attendee',
      optional: item.optional,
      status: item.status ?? 'needs_action',
      comment: item.comment ?? null,
      respondedAt: item.respondedAt ?? null,
    })),
  ]
  if (attendeeRows.length > 0) await tx.insert(eventAttendees).values(attendeeRows)
  const grants = [...new Set([spec.organizerId, ...people.map((item) => item.userId)])].filter(
    (id): id is string => Boolean(id) && id !== spec.ownerId,
  )
  if (grants.length > 0) {
    await grantAccess(
      tx,
      ctx,
      row.id,
      grants.map((id) => ({ principal: { type: 'user' as const, id }, level: ATTENDEE_LEVEL })),
      { quiet: true },
    )
  }
  if (spec.resourceIds.length > 0) {
    await tx
      .insert(eventResources)
      .values(spec.resourceIds.map((resourceId) => ({ eventId: row.id, resourceId })))
  }
  for (const targetId of spec.linkedObjectIds) {
    await LinkService.link(tx, ctx, row.id, targetId, 'related')
  }
  await materialize(tx, row)
  return row
}

/** Связанные объекты — только видимые пользователю. */
export async function assertLinkable(ctx: Ctx, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)]
  for (const id of unique) await authorize(ctx, 'view', id)
  return unique
}

export function remindersOf(value: Reminder[] | undefined, fallback: Reminder[]): ReminderValue[] {
  return (value ?? fallback).map((item) => ({
    minutes: item.minutes,
    channels: [...new Set(item.channels)],
  }))
}

export const transparencyOf = (showAs: 'busy' | 'free') =>
  showAs === 'free' ? 'transparent' : 'opaque'

/** Календарь, в котором пользователь может создавать события. */
export async function writableCalendar(
  tx: Tx,
  ctx: UserCtx,
  calendarId: string | undefined,
): Promise<CalendarRow> {
  const id = calendarId ?? (await CalendarService.ensurePersonal(tx, ctx, principalUser(ctx)))
  const calendar = await loadCalendar(tx, id)
  if (!calendar) throw errors.notFound('Календарь')
  // Объект — из транзакции: личный календарь мог быть создан только что
  await authorize(ctx, 'create_event', (await loadObject(id, tx)) ?? id)
  if (calendar.kind === 'resource' || calendar.kind === 'subscription') {
    validation('calendarId', 'В этот календарь нельзя добавлять события')
  }
  return calendar
}

/** Организатор: в личном календаре — его владелец, в остальных — автор. */
export function organizerFor(calendar: CalendarRow, ctx: UserCtx): string {
  return calendar.kind === 'personal' && calendar.ownerId ? calendar.ownerId : principalUser(ctx)
}

export function dedupeAttendees(
  items: Array<{ userId: string; optional: boolean }>,
  organizerId: string | null,
): Array<{ userId: string; optional: boolean }> {
  const seen = new Map<string, { userId: string; optional: boolean }>()
  for (const item of items) {
    if (item.userId === organizerId) continue
    seen.set(item.userId, item)
  }
  return [...seen.values()]
}

export function pickOverrides(
  row: EventRow,
  keep: (key: string) => boolean,
): Record<string, OccurrenceOverride> {
  const result: Record<string, OccurrenceOverride> = {}
  for (const [key, value] of Object.entries(row.overrides as Record<string, OccurrenceOverride>)) {
    if (keep(key)) result[key] = value
  }
  return result
}

export function timeOfOccurrence(row: EventRow, occurrence: Occurrence): SeriesTime {
  return {
    allDay: row.allDay,
    startsAt: occurrence.startsAt,
    endsAt: occurrence.endsAt,
    startDate: occurrence.startDate,
    endDate: occurrence.endDate,
    timezone: row.timezone,
  }
}

export const text = (value: string | null | undefined) => value?.trim() || null
