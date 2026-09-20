import {
  type AttendeeStatus,
  atLeast,
  type CalendarColor,
  type CalendarKind,
  type EventCancelInput,
  type EventCreateInput,
  type EventEditScope,
  type EventRecord,
  type EventRespondInput,
  type EventUpdateInput,
  type EventVisibility,
  type Reminder,
  type ResourceKind,
  type UserRef,
} from '@kchs/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { grantAccess, revokeAccess, setAccessMode } from '~/kernel/access/acl-service.js'
import { authorize, loadObject } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import type { EventInput } from '~/kernel/events/types.js'
import { LinkService } from '~/kernel/links/service.js'
import { hiddenSummary, ObjectService } from '~/kernel/objects/service.js'
import { config } from '~/shared/config/index.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import {
  calendars,
  eventAttendees,
  eventInstances,
  eventResources,
  events,
  objects,
  type ReminderValue,
} from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import { CalendarInbox } from './calendar-inbox.js'
import {
  type CalendarRow,
  CalendarService,
  loadCalendar,
  principalUser,
} from './calendar-service.js'
import { cancelEventMeeting, syncEventMeeting } from './event-meeting.js'
import {
  type EventRow,
  inclusiveEnd,
  materialize,
  rematerializeOccurrence,
  seriesOf,
} from './instances.js'
import {
  hasOccurrence,
  normalizeRule,
  type Occurrence,
  type OccurrenceOverride,
  occurrenceOf,
  RecurrenceError,
  type SeriesTime,
  shiftSeriesKeys,
  tailRule,
  truncateBefore,
} from './recurrence.js'
import { dropReminders, planReminders, replanReminders } from './reminders.js'
import { calendarSettings } from './settings.js'
import { addDays, DAY_MS, iso, localDate, startOfDate } from './time.js'

/**
 * События календаря (12-calendar-notifications-home.md §1, ADR-0081): объект
 * реестра и строка события, участники с их правами, бронь ресурсов,
 * материализация экземпляров, приглашения во Входящих, напоминания и события —
 * в одной транзакции.
 */

/** Право участника: видеть и обсуждать встречу (правят организатор и редакторы календаря). */
const ATTENDEE_LEVEL = 'comment' as const
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

async function attendeesOf(executor: Executor, eventId: string): Promise<AttendeeRow[]> {
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

async function resourceIdsOf(executor: Executor, eventId: string): Promise<string[]> {
  const rows = await executor
    .select({ id: eventResources.resourceId })
    .from(eventResources)
    .where(eq(eventResources.eventId, eventId))
  return rows.map((row) => row.id)
}

function validation(path: string, message: string): never {
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
function timeOf(input: TimeInput, timezone: string, current: SeriesTime | null): SeriesTime {
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

function ruleOf(raw: string | null | undefined, time: SeriesTime): string | null {
  if (!raw) return null
  try {
    return normalizeRule(raw, time)
  } catch (error) {
    if (error instanceof RecurrenceError) validation('rrule', error.message)
    throw error
  }
}

function sameTime(a: SeriesTime, b: SeriesTime): boolean {
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
async function assertPeople(ids: string[]): Promise<void> {
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
async function assertResources(tx: Executor, ctx: Ctx, ids: string[]): Promise<void> {
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
async function assertResourcesFree(tx: Executor, eventId: string, ids: string[]): Promise<void> {
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

function metaOf(row: {
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

async function emit(
  tx: Executor,
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
export async function insertEvent(tx: Executor, ctx: Ctx, spec: EventSpec): Promise<EventRow> {
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
async function assertLinkable(ctx: Ctx, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)]
  for (const id of unique) await authorize(ctx, 'view', id)
  return unique
}

function remindersOf(value: Reminder[] | undefined, fallback: Reminder[]): ReminderValue[] {
  return (value ?? fallback).map((item) => ({
    minutes: item.minutes,
    channels: [...new Set(item.channels)],
  }))
}

const transparencyOf = (showAs: 'busy' | 'free') => (showAs === 'free' ? 'transparent' : 'opaque')

/** Календарь, в котором пользователь может создавать события. */
async function writableCalendar(
  tx: Executor,
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
function organizerFor(calendar: CalendarRow, ctx: UserCtx): string {
  return calendar.kind === 'personal' && calendar.ownerId ? calendar.ownerId : principalUser(ctx)
}

function dedupeAttendees(
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

function pickOverrides(
  row: EventRow,
  keep: (key: string) => boolean,
): Record<string, OccurrenceOverride> {
  const result: Record<string, OccurrenceOverride> = {}
  for (const [key, value] of Object.entries(row.overrides as Record<string, OccurrenceOverride>)) {
    if (keep(key)) result[key] = value
  }
  return result
}

function timeOfOccurrence(row: EventRow, occurrence: Occurrence): SeriesTime {
  return {
    allDay: row.allDay,
    startsAt: occurrence.startsAt,
    endsAt: occurrence.endsAt,
    startDate: occurrence.startDate,
    endDate: occurrence.endDate,
    timezone: row.timezone,
  }
}

const text = (value: string | null | undefined) => value?.trim() || null

export const EventService = {
  async create(tx: Executor, ctx: UserCtx, input: EventCreateInput): Promise<string> {
    const calendar = await writableCalendar(tx, ctx, input.calendarId)
    const timezone = input.timezone ?? calendar.timezone
    const time = timeOf(input, timezone, null)
    const rrule = ruleOf(input.rrule, time)
    const organizerId = organizerFor(calendar, ctx)
    const attendees = dedupeAttendees(input.attendees, organizerId)
    await assertPeople(attendees.map((item) => item.userId))
    const resourceIds = [...new Set(input.resourceIds)]
    await assertResources(tx, ctx, resourceIds)
    const linkedObjectIds = await assertLinkable(ctx, input.linkedObjectIds)
    const settings = await calendarSettings(organizerId)

    const row = await insertEvent(tx, ctx, {
      calendar,
      title: input.title,
      description: text(input.description),
      location: text(input.location),
      time,
      rrule,
      exdates: [],
      overrides: {},
      visibility: input.visibility,
      transparency: transparencyOf(input.showAs ?? (time.allDay ? 'free' : 'busy')),
      color: input.color ?? null,
      reminders: remindersOf(input.reminders, settings.defaultReminders),
      ownerId: organizerId,
      organizerId,
      attendees,
      resourceIds,
      linkedObjectIds,
      source: 'local',
    })
    await assertResourcesFree(tx, row.id, resourceIds)

    // Онлайн-встреча: комната медиасервера заводится вместе с событием (ADR-0089)
    const meeting = await syncEventMeeting(tx, ctx, {
      eventId: row.id,
      meetingId: null,
      wanted: input.onlineMeeting,
      title: input.title,
      organizerId,
      participantIds: attendees.map((item) => item.userId),
      startsAt: row.startsAt,
      endsAt: row.endsAt,
    })
    if (meeting.meetingId) {
      await tx.update(events).set({ meetingId: meeting.meetingId }).where(eq(events.id, row.id))
    }

    const view = { id: row.id, spaceId: calendar.spaceId, title: input.title }
    await emit(tx, ctx, view, 'event.created', {
      calendarId: calendar.id,
      startsAt: row.startsAt,
      allDay: row.allDay,
      recurring: Boolean(rrule),
    })
    const invited = attendees.map((item) => item.userId)
    if (invited.length > 0) {
      await emit(tx, ctx, view, 'event.invited', { userIds: invited })
      await CalendarInbox.invite(tx, ctx, await nextOccurrence(tx, row), invited)
    }
    await planReminders(tx, [row.id])
    return row.id
  },

  /**
   * Правка. Повторяющееся событие: «только это» — правка экземпляра (время,
   * название, место, описание), «это и следующие» — серия делится, продолжение
   * — отдельное событие; «вся серия» — само правило. Возвращает событие,
   * которое правилось (для «это и следующие» — продолжение серии).
   */
  async update(tx: Executor, ctx: UserCtx, id: string, input: EventUpdateInput): Promise<string> {
    await authorize(ctx, 'edit', id)
    const loaded = await loadEvent(tx, id, true)
    if (!loaded) throw errors.notFound('Событие')
    if (loaded.row.source === 'subscription') {
      throw errors.forbidden('События подписки меняются только в источнике')
    }
    const scope: EventEditScope = loaded.row.rrule ? input.scope : 'series'
    if (scope === 'series') return updateSeries(tx, ctx, loaded, input)
    const recurrenceId = Date.parse(input.recurrenceId ?? '')
    if (!hasOccurrence(seriesOf(loaded.row), recurrenceId)) {
      throw errors.notFound('Экземпляр события')
    }
    if (scope === 'occurrence') return updateOccurrence(tx, ctx, loaded, input, recurrenceId)
    return splitSeries(tx, ctx, loaded, input, recurrenceId)
  },

  /** Отмена: экземпляр, «это и следующие» или событие целиком (в корзину). */
  async cancel(tx: Executor, ctx: UserCtx, id: string, input: EventCancelInput): Promise<void> {
    await authorize(ctx, 'edit', id)
    const loaded = await loadEvent(tx, id, true)
    if (!loaded) throw errors.notFound('Событие')
    if (loaded.row.source === 'subscription') {
      throw errors.forbidden('События подписки меняются только в источнике')
    }
    const { row } = loaded
    const series = seriesOf(row)
    let scope: EventEditScope = row.rrule ? input.scope : 'series'
    const recurrenceId = input.recurrenceId ? Date.parse(input.recurrenceId) : null
    if (scope !== 'series' && (recurrenceId === null || !hasOccurrence(series, recurrenceId))) {
      throw errors.notFound('Экземпляр события')
    }
    // «Это и следующие» с первого экземпляра — вся серия
    const head =
      scope === 'following' && recurrenceId !== null ? truncateBefore(series, recurrenceId) : null
    if (scope === 'following' && head === null) scope = 'series'

    if (scope === 'occurrence' && recurrenceId !== null) {
      const key = iso(recurrenceId)
      const overrides = { ...(row.overrides as Record<string, OccurrenceOverride>) }
      delete overrides[key]
      const exdates = [...new Set([...row.exdates, key])]
      await tx
        .update(events)
        .set({ exdates, overrides, sequence: row.sequence + 1 })
        .where(eq(events.id, id))
      await rematerializeOccurrence(tx, row, null, key)
      await replanReminders(tx, [id])
    } else if (scope === 'following' && recurrenceId !== null && head !== null) {
      const next: EventRow = {
        ...row,
        rrule: head,
        exdates: row.exdates.filter((key) => Date.parse(key) < recurrenceId),
        overrides: pickOverrides(row, (key) => Date.parse(key) < recurrenceId),
        sequence: row.sequence + 1,
      }
      await tx
        .update(events)
        .set({
          rrule: next.rrule,
          exdates: next.exdates,
          overrides: next.overrides,
          sequence: next.sequence,
        })
        .where(eq(events.id, id))
      await materialize(tx, next)
      await replanReminders(tx, [id])
      await ObjectService.update(
        tx,
        ctx,
        id,
        { meta: metaOf(next), mergeMeta: true },
        { silent: true },
      )
    } else {
      // Событие отменено целиком — онлайн-встреча закрывается для всех (ADR-0089)
      await cancelEventMeeting(tx, ctx, row.meetingId)
      await ObjectService.trash(tx, ctx, id)
      await CalendarInbox.close(tx, ctx, id, undefined, 'dismissed')
      await dropReminders(tx, id)
    }
    await emit(tx, ctx, { id, spaceId: loaded.spaceId, title: loaded.title }, 'event.cancelled', {
      calendarId: row.calendarId,
      scope,
      recurrenceId: scope !== 'series' && recurrenceId !== null ? iso(recurrenceId) : null,
    })
  },

  /** Ответ участника: да, возможно, нет — с комментарием и предложением другого времени. */
  async respond(tx: Executor, ctx: UserCtx, id: string, input: EventRespondInput): Promise<void> {
    await authorize(ctx, 'view', id)
    const loaded = await loadEvent(tx, id, true)
    if (!loaded) throw errors.notFound('Событие')
    const me = principalUser(ctx)
    const attendees = await attendeesOf(tx, id)
    const mine = attendees.find((item) => item.userId === me)
    if (!mine || mine.role === 'organizer') {
      throw errors.forbidden('Ответить может только приглашённый участник')
    }
    if (
      input.proposal &&
      Date.parse(input.proposal.endsAt) <= Date.parse(input.proposal.startsAt)
    ) {
      validation('proposal', 'Окончание раньше начала')
    }
    await tx
      .update(eventAttendees)
      .set({
        status: input.status,
        comment: text(input.comment),
        proposal: input.proposal ?? null,
        respondedAt: new Date().toISOString(),
      })
      .where(and(eq(eventAttendees.eventId, id), eq(eventAttendees.userId, me)))
    await CalendarInbox.close(tx, ctx, id, me)
    if (input.status === 'declined') {
      await dropReminders(tx, id, me)
    } else {
      await planReminders(tx, [id], me)
    }
    await emit(tx, ctx, { id, spaceId: loaded.spaceId, title: loaded.title }, 'event.responded', {
      userId: me,
      status: input.status,
      proposed: Boolean(input.proposal),
    })
  },

  /** Свои напоминания участника; `null` — напоминания события. */
  async setMyReminders(
    tx: Executor,
    ctx: UserCtx,
    id: string,
    reminders: Reminder[] | null,
  ): Promise<void> {
    await authorize(ctx, 'view', id)
    const me = principalUser(ctx)
    const updated = await tx
      .update(eventAttendees)
      .set({ reminders: reminders ? remindersOf(reminders, []) : null })
      .where(and(eq(eventAttendees.eventId, id), eq(eventAttendees.userId, me)))
      .returning({ userId: eventAttendees.userId })
    if (updated.length === 0) throw errors.forbidden('Напоминания задают участники события')
    await dropReminders(tx, id, me)
    await planReminders(tx, [id], me)
  },

  async get(ctx: UserCtx, id: string, recurrenceId?: string): Promise<EventRecord> {
    const decision = await authorize(ctx, 'view', id)
    const loaded = await loadEvent(db(), id)
    if (!loaded) throw errors.notFound('Событие')
    const { row } = loaded
    const calendar = await loadCalendar(db(), row.calendarId)
    if (!calendar) throw errors.notFound('Календарь')
    const attendees = await attendeesOf(db(), id)
    const ids = new Set([principalUser(ctx), ctx.userId])
    const participant = attendees.some((item) => ids.has(item.userId))
    const calendarDecision = await authorize(ctx, 'view', calendar.id, { soft: true })
    const detailed =
      participant ||
      row.visibility === 'public' ||
      (row.visibility === 'busy' && atLeast(calendarDecision.level, 'edit'))
    const mine = attendees.find((item) => ids.has(item.userId)) ?? null

    let occurrence: EventRecord['occurrence'] = null
    if (recurrenceId) {
      const [instance] = await db()
        .select()
        .from(eventInstances)
        .where(
          and(
            eq(eventInstances.eventId, id),
            eq(eventInstances.recurrenceId, new Date(recurrenceId).toISOString()),
          ),
        )
        .limit(1)
      if (instance) {
        occurrence = {
          recurrenceId: instance.recurrenceId,
          startsAt: instance.startsAt,
          endsAt: instance.endsAt,
          startDate: instance.startDate,
          endDate: inclusiveEnd(instance.endDate),
          overridden: instance.overridden,
        }
      }
    }
    const calendarRef = {
      id: calendar.id,
      title: calendar.title,
      kind: calendar.kind as CalendarKind,
      color: calendar.color as CalendarColor,
    }
    const base = {
      id,
      calendar: calendarRef,
      allDay: row.allDay,
      timezone: row.timezone,
      visibility: row.visibility as EventVisibility,
      showAs: row.transparency === 'transparent' ? ('free' as const) : ('busy' as const),
      source: row.source as EventRecord['source'],
      occurrence,
      version: loaded.version,
      createdAt: loaded.createdAt,
      updatedAt: loaded.updatedAt,
    }
    if (!detailed) {
      return {
        ...base,
        busy: true,
        title: '',
        description: null,
        location: null,
        startsAt: occurrence?.startsAt ?? row.startsAt,
        endsAt: occurrence?.endsAt ?? row.endsAt,
        startDate: occurrence?.startDate ?? row.startDate,
        endDate: occurrence ? occurrence.endDate : inclusiveEnd(row.endDate),
        rrule: null,
        exdates: [],
        color: null,
        organizer: null,
        attendees: [],
        resources: [],
        reminders: [],
        myReminders: null,
        myStatus: null,
        linkedObjects: [],
        meetingId: null,
        seriesId: null,
        can: { edit: false, respond: false, cancel: false, manage: false },
      }
    }

    const resourceIds = await resourceIdsOf(db(), id)
    const peopleIds = [
      ...new Set([...attendees.map((item) => item.userId), row.organizerId]),
    ].filter((value): value is string => Boolean(value))
    const [people, resourceRows, summaries] = await Promise.all([
      directory().refs(peopleIds),
      resourceIds.length > 0
        ? db()
            .select({
              id: calendars.id,
              title: objects.title,
              resource: calendars.resource,
              color: calendars.color,
            })
            .from(calendars)
            .innerJoin(objects, eq(objects.id, calendars.id))
            .where(inArray(calendars.id, resourceIds))
        : Promise.resolve([]),
      ObjectService.summaries(row.linkedObjectIds),
    ])
    const linkedObjects = []
    for (const linkedId of row.linkedObjectIds) {
      const summary = summaries.get(linkedId)
      if (!summary) continue
      const allowed = await authorize(ctx, 'view', linkedId, { soft: true })
      linkedObjects.push(allowed.allowed ? summary : hiddenSummary(summary))
    }
    const editable = atLeast(decision.level, 'edit') && row.source !== 'subscription'
    const order: Record<string, number> = { organizer: 0, attendee: 1 }
    return {
      ...base,
      busy: false,
      title: loaded.title,
      description: row.description,
      location: row.location,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      startDate: row.startDate,
      endDate: inclusiveEnd(row.endDate),
      rrule: row.rrule,
      exdates: row.exdates,
      color: (row.color as CalendarColor | null) ?? null,
      organizer: row.organizerId ? (people.get(row.organizerId) ?? null) : null,
      attendees: attendees
        .filter((item) => people.has(item.userId))
        .sort((a, b) => (order[a.role] ?? 2) - (order[b.role] ?? 2))
        .map((item) => ({
          user: people.get(item.userId) as UserRef,
          role: item.role === 'organizer' ? ('organizer' as const) : ('attendee' as const),
          optional: item.optional,
          status: item.status as AttendeeStatus,
          comment: item.comment,
          proposal: item.proposal
            ? { ...item.proposal, recurrenceId: item.proposal.recurrenceId ?? null }
            : null,
          respondedAt: item.respondedAt,
        })),
      resources: resourceRows.map((resource) => {
        const info = resource.resource as { kind?: string; location?: string | null } | null
        return {
          id: resource.id,
          title: resource.title,
          kind: (info?.kind ?? 'room') as ResourceKind,
          location: info?.location ?? null,
          color: resource.color as CalendarColor,
        }
      }),
      reminders: row.reminders as Reminder[],
      myReminders: (mine?.reminders as Reminder[] | null) ?? null,
      myStatus: (mine?.status as AttendeeStatus | undefined) ?? null,
      linkedObjects,
      meetingId: row.meetingId,
      seriesId: row.seriesId,
      can: {
        edit: editable,
        respond: mine?.role === 'attendee',
        cancel: editable,
        manage: atLeast(decision.level, 'manage'),
      },
    }
  },
}

/** Правка одного экземпляра серии: время, название, место, описание. */
async function updateOccurrence(
  tx: Executor,
  ctx: UserCtx,
  loaded: LoadedEvent,
  input: EventUpdateInput,
  recurrenceId: number,
): Promise<string> {
  const { row } = loaded
  const allowed = new Set([
    'scope',
    'recurrenceId',
    'title',
    'description',
    'location',
    'startsAt',
    'endsAt',
    'startDate',
    'endDate',
    'allDay',
    'timezone',
  ])
  const only = 'Для одного повторения меняются только время, название, место и описание'
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && !allowed.has(key)) validation(key, only)
  }
  if (input.allDay !== undefined && input.allDay !== row.allDay) validation('allDay', only)
  if (input.timezone !== undefined && input.timezone !== row.timezone) validation('timezone', only)
  const key = iso(recurrenceId)
  const current = occurrenceOf(seriesOf(row), recurrenceId)
  if (!current) throw errors.notFound('Экземпляр события')
  const currentTime = timeOfOccurrence(row, current)
  const time = timeOf({ ...input, allDay: row.allDay }, row.timezone, currentTime)
  const timeChanged = !sameTime(time, currentTime)
  const change: OccurrenceOverride = {
    ...((row.overrides as Record<string, OccurrenceOverride>)[key] ?? {}),
  }
  if (row.allDay) {
    if (time.startDate) change.startDate = time.startDate
    if (time.endDate) change.endDate = time.endDate
  } else {
    change.startsAt = iso(time.startsAt)
    change.endsAt = iso(time.endsAt)
  }
  if (input.title !== undefined) change.title = input.title
  if (input.location !== undefined) change.location = text(input.location)
  if (input.description !== undefined) change.description = text(input.description)
  const overrides = { ...(row.overrides as Record<string, OccurrenceOverride>), [key]: change }
  await tx
    .update(events)
    .set({ overrides, sequence: row.sequence + 1 })
    .where(eq(events.id, row.id))
  const next: EventRow = { ...row, overrides }
  await rematerializeOccurrence(tx, next, occurrenceOf(seriesOf(next), recurrenceId), key)
  await replanReminders(tx, [row.id])
  const changed = [
    ...(timeChanged ? ['time'] : []),
    ...(['title', 'location', 'description'] as const).filter(
      (field) => input[field] !== undefined,
    ),
  ]
  await emit(
    tx,
    ctx,
    { id: row.id, spaceId: loaded.spaceId, title: loaded.title },
    'event.updated',
    {
      calendarId: row.calendarId,
      changed,
      scope: 'occurrence',
      recurrenceId: key,
      timeChanged,
      startsAt: iso(time.startsAt),
    },
  )
  return row.id
}

/** Правка события целиком (или всей серии). */
async function updateSeries(
  tx: Executor,
  ctx: UserCtx,
  loaded: LoadedEvent,
  input: EventUpdateInput,
): Promise<string> {
  const { row } = loaded
  const changed: string[] = []

  // Календарь: перенос в другой — право создавать события в нём
  let calendar = await loadCalendar(tx, row.calendarId)
  if (!calendar) throw errors.notFound('Календарь')
  if (input.calendarId && input.calendarId !== row.calendarId) {
    calendar = await writableCalendar(tx, ctx, input.calendarId)
    changed.push('calendar')
  }

  const timezone = input.timezone ?? row.timezone
  const series = seriesOf(row)
  const time = timeOf(input, timezone, series)
  const timeChanged = !sameTime(time, series)
  const rrule = input.rrule === undefined ? row.rrule : ruleOf(input.rrule, time)
  const ruleChanged = rrule !== row.rrule
  let exdates = row.exdates
  let overrides = row.overrides as Record<string, OccurrenceOverride>
  if (rrule && (timeChanged || ruleChanged)) {
    // Исключения и правки переезжают вслед за началом серии — у существующих экземпляров
    const shifted = timeChanged
      ? shiftSeriesKeys(series, time)
      : { exdates: [...row.exdates], overrides }
    const candidate = { ...time, rrule, exdates: [], overrides: {} }
    exdates = shifted.exdates.filter((key) => hasOccurrence(candidate, Date.parse(key)))
    overrides = {}
    for (const [key, value] of Object.entries(shifted.overrides)) {
      if (hasOccurrence(candidate, Date.parse(key))) overrides[key] = value
    }
  } else if (!rrule) {
    exdates = []
    overrides = {}
  }
  if (timeChanged) changed.push('time')
  if (ruleChanged) changed.push('rrule')

  const visibility = input.visibility ?? (row.visibility as EventVisibility)
  if (visibility !== row.visibility) {
    // Права участников — свои записи; наследуемые при закрытии не копируются
    await setAccessMode(tx, ctx, row.id, visibility === 'public' ? 'inherit' : 'restricted', {
      copyInherited: false,
    })
    changed.push('visibility')
  }

  const values: Partial<typeof events.$inferInsert> = {
    calendarId: calendar.id,
    startsAt: iso(time.startsAt),
    endsAt: iso(time.endsAt),
    allDay: time.allDay,
    startDate: time.startDate,
    endDate: time.endDate,
    timezone: time.timezone,
    rrule,
    exdates,
    overrides,
    visibility,
  }
  if (input.description !== undefined && text(input.description) !== row.description) {
    values.description = text(input.description)
    changed.push('description')
  }
  if (input.location !== undefined && text(input.location) !== row.location) {
    values.location = text(input.location)
    changed.push('location')
  }
  if (input.showAs !== undefined && transparencyOf(input.showAs) !== row.transparency) {
    values.transparency = transparencyOf(input.showAs)
    changed.push('showAs')
  }
  if (input.color !== undefined && input.color !== row.color) {
    values.color = input.color
    changed.push('color')
  }
  if (input.reminders !== undefined) {
    values.reminders = remindersOf(input.reminders, [])
    changed.push('reminders')
  }
  if (timeChanged || ruleChanged || changed.includes('location')) values.sequence = row.sequence + 1

  // Связанные объекты: добавленные — только видимые пользователю
  if (input.linkedObjectIds !== undefined) {
    const next = await assertLinkable(ctx, input.linkedObjectIds)
    const before = new Set(row.linkedObjectIds)
    for (const targetId of next) {
      if (!before.has(targetId)) await LinkService.link(tx, ctx, row.id, targetId, 'related')
    }
    for (const targetId of row.linkedObjectIds) {
      if (!next.includes(targetId)) await LinkService.unlink(tx, ctx, row.id, targetId, 'related')
    }
    values.linkedObjectIds = next
    if (next.join() !== row.linkedObjectIds.join()) changed.push('links')
  }

  await tx.update(events).set(values).where(eq(events.id, row.id))
  const next: EventRow = { ...row, ...(values as Partial<EventRow>) }

  if (changed.includes('calendar')) {
    await ObjectService.move(tx, ctx, row.id, {
      parentId: calendar.id,
      ...(calendar.spaceId ? { spaceId: calendar.spaceId } : {}),
    })
  }

  // Участники: добавленные получают право и приглашение, исключённые — теряют
  const attendees = await attendeesOf(tx, row.id)
  const invited: string[] = []
  const removed: string[] = []
  if (input.attendees !== undefined) {
    const wanted = dedupeAttendees(input.attendees, row.organizerId)
    await assertPeople(
      wanted
        .filter((item) => !attendees.some((current) => current.userId === item.userId))
        .map((item) => item.userId),
    )
    for (const item of wanted) {
      const current = attendees.find((existing) => existing.userId === item.userId)
      if (!current) {
        await tx.insert(eventAttendees).values({
          eventId: row.id,
          userId: item.userId,
          role: 'attendee',
          optional: item.optional,
          status: 'needs_action',
        })
        invited.push(item.userId)
      } else if (current.optional !== item.optional) {
        await tx
          .update(eventAttendees)
          .set({ optional: item.optional })
          .where(and(eq(eventAttendees.eventId, row.id), eq(eventAttendees.userId, item.userId)))
      }
    }
    for (const current of attendees) {
      if (current.role === 'organizer') continue
      if (!wanted.some((item) => item.userId === current.userId)) removed.push(current.userId)
    }
    const grants = invited.filter((userId) => userId !== loaded.ownerId)
    if (grants.length > 0) {
      await grantAccess(
        tx,
        ctx,
        row.id,
        grants.map((userId) => ({
          principal: { type: 'user' as const, id: userId },
          level: ATTENDEE_LEVEL,
        })),
        { quiet: true },
      )
    }
    for (const userId of removed) {
      await tx
        .delete(eventAttendees)
        .where(and(eq(eventAttendees.eventId, row.id), eq(eventAttendees.userId, userId)))
      if (userId !== loaded.ownerId) {
        await revokeAccess(tx, ctx, row.id, { type: 'user', id: userId })
      }
      await CalendarInbox.close(tx, ctx, row.id, userId, 'dismissed')
      await dropReminders(tx, row.id, userId)
    }
    if (invited.length > 0 || removed.length > 0) changed.push('attendees')
  }

  // Ресурсы: новые — с проверкой права и занятости
  let resourceIds = await resourceIdsOf(tx, row.id)
  if (input.resourceIds !== undefined) {
    const wanted = [...new Set(input.resourceIds)]
    const added = wanted.filter((id) => !resourceIds.includes(id))
    await assertResources(tx, ctx, added)
    if (added.length > 0) {
      await tx
        .insert(eventResources)
        .values(added.map((resourceId) => ({ eventId: row.id, resourceId })))
    }
    const dropped = resourceIds.filter((id) => !wanted.includes(id))
    if (dropped.length > 0) {
      await tx
        .delete(eventResources)
        .where(and(eq(eventResources.eventId, row.id), inArray(eventResources.resourceId, dropped)))
    }
    if (added.length > 0 || dropped.length > 0) changed.push('resources')
    resourceIds = wanted
  }

  if (timeChanged || ruleChanged || changed.includes('calendar')) await materialize(tx, next)
  if (timeChanged || ruleChanged || changed.includes('resources')) {
    await assertResourcesFree(tx, row.id, resourceIds)
  }
  if (timeChanged) {
    // Предложения другого времени устарели вместе со старым временем
    await tx
      .update(eventAttendees)
      .set({ proposal: null })
      .where(and(eq(eventAttendees.eventId, row.id), sql`${eventAttendees.proposal} IS NOT NULL`))
  }

  const title = input.title ?? loaded.title
  if (input.title !== undefined && input.title !== loaded.title) {
    await ObjectService.update(tx, ctx, row.id, { title: input.title })
    changed.push('title')
  }

  // Онлайн-встреча: включили или выключили — заводим или закрываем комнату,
  // состав участников встречи идёт за участниками события (ADR-0089)
  const meeting = await syncEventMeeting(tx, ctx, {
    eventId: row.id,
    meetingId: row.meetingId,
    wanted: input.onlineMeeting,
    title,
    organizerId: row.organizerId,
    participantIds: (await attendeesOf(tx, row.id)).map((item) => item.userId),
    startsAt: next.startsAt,
    endsAt: next.endsAt,
  })
  if (meeting.changed) {
    await tx.update(events).set({ meetingId: meeting.meetingId }).where(eq(events.id, row.id))
    next.meetingId = meeting.meetingId
    changed.push('meeting')
  }
  await ObjectService.update(
    tx,
    ctx,
    row.id,
    { meta: metaOf(next), mergeMeta: true },
    { silent: true },
  )

  const view = { id: row.id, spaceId: calendar.spaceId, title }
  if (changed.length > 0) {
    await emit(tx, ctx, view, 'event.updated', {
      calendarId: calendar.id,
      changed,
      scope: 'series',
      recurrenceId: null,
      timeChanged: timeChanged || ruleChanged,
      startsAt: iso(time.startsAt),
    })
  }
  if (invited.length > 0) {
    await emit(tx, ctx, view, 'event.invited', { userIds: invited })
    await CalendarInbox.invite(tx, ctx, await nextOccurrence(tx, next), invited)
  }
  if (removed.length > 0) await emit(tx, ctx, view, 'event.uninvited', { userIds: removed })
  if (timeChanged || ruleChanged) {
    // Ещё не ответившим — приглашение с новым сроком
    const pending = attendees
      .filter((item) => item.role === 'attendee' && item.status === 'needs_action')
      .map((item) => item.userId)
      .filter((userId) => !removed.includes(userId))
    if (pending.length > 0) {
      await CalendarInbox.reopen(tx, ctx, await nextOccurrence(tx, next), pending)
    }
  }
  if (changed.length > 0) await replanReminders(tx, [row.id])
  return row.id
}

/**
 * «Это и следующие»: серия обрывается перед экземпляром, продолжение — новое
 * событие с правкой. Участники переносятся; если время изменилось, их ответы
 * сбрасываются.
 */
async function splitSeries(
  tx: Executor,
  ctx: UserCtx,
  loaded: LoadedEvent,
  input: EventUpdateInput,
  recurrenceId: number,
): Promise<string> {
  const { row } = loaded
  const series = seriesOf(row)
  const head = truncateBefore(series, recurrenceId)
  if (head === null) return updateSeries(tx, ctx, loaded, { ...input, scope: 'series' })
  const calendar = input.calendarId
    ? await writableCalendar(tx, ctx, input.calendarId)
    : await loadCalendar(tx, row.calendarId)
  if (!calendar) throw errors.notFound('Календарь')

  // Исходный экземпляр — точка отсчёта сдвига исключений, действующий — «было»
  const base = occurrenceOf(series, recurrenceId, false)
  const effective = occurrenceOf(series, recurrenceId)
  if (!base || !effective) throw errors.notFound('Экземпляр события')
  const effectiveTime = timeOfOccurrence(row, effective)
  const timezone = input.timezone ?? row.timezone
  const time = timeOf(input, timezone, effectiveTime)
  const timeChanged = !sameTime(time, effectiveTime)
  const tail = input.rrule === undefined ? tailRule(series, recurrenceId) : input.rrule
  const rrule = ruleOf(tail, time)

  // Голова серии — до экземпляра
  const headRow: EventRow = {
    ...row,
    rrule: head,
    exdates: row.exdates.filter((key) => Date.parse(key) < recurrenceId),
    overrides: pickOverrides(row, (key) => Date.parse(key) < recurrenceId),
    sequence: row.sequence + 1,
  }
  await tx
    .update(events)
    .set({
      rrule: headRow.rrule,
      exdates: headRow.exdates,
      overrides: headRow.overrides,
      sequence: headRow.sequence,
    })
    .where(eq(events.id, row.id))
  await materialize(tx, headRow)
  await replanReminders(tx, [row.id])
  await ObjectService.update(
    tx,
    ctx,
    row.id,
    { meta: metaOf(headRow), mergeMeta: true },
    { silent: true },
  )

  // Исключения продолжения — вслед за его началом; правки отдельных экземпляров не переносятся
  const later = row.exdates.filter((key) => Date.parse(key) > recurrenceId)
  const baseTime = timeOfOccurrence(row, base)
  const tailExdates = sameTime(time, baseTime)
    ? later
    : shiftSeriesKeys({ ...baseTime, rrule: row.rrule, exdates: later, overrides: {} }, time)
        .exdates

  const attendees = await attendeesOf(tx, row.id)
  const wanted = input.attendees
    ? dedupeAttendees(input.attendees, row.organizerId)
    : attendees
        .filter((item) => item.role === 'attendee')
        .map((item) => ({ userId: item.userId, optional: item.optional }))
  await assertPeople(
    wanted
      .filter((item) => !attendees.some((current) => current.userId === item.userId))
      .map((item) => item.userId),
  )
  const currentResources = await resourceIdsOf(tx, row.id)
  const resourceIds = input.resourceIds ? [...new Set(input.resourceIds)] : currentResources
  await assertResources(
    tx,
    ctx,
    resourceIds.filter((id) => !currentResources.includes(id)),
  )
  const linkedObjectIds =
    input.linkedObjectIds !== undefined
      ? await assertLinkable(ctx, input.linkedObjectIds)
      : row.linkedObjectIds
  const title = input.title ?? loaded.title

  const created = await insertEvent(tx, ctx, {
    calendar,
    title,
    description: input.description !== undefined ? text(input.description) : row.description,
    location: input.location !== undefined ? text(input.location) : row.location,
    time,
    rrule,
    exdates: tailExdates,
    overrides: {},
    visibility: input.visibility ?? (row.visibility as EventVisibility),
    transparency:
      input.showAs !== undefined
        ? transparencyOf(input.showAs)
        : (row.transparency as 'opaque' | 'transparent'),
    color: input.color !== undefined ? input.color : (row.color as CalendarColor | null),
    reminders: input.reminders !== undefined ? remindersOf(input.reminders, []) : row.reminders,
    ownerId: loaded.ownerId,
    organizerId: row.organizerId,
    attendees: wanted.map((item) => {
      const before = attendees.find((current) => current.userId === item.userId)
      const keep = before !== undefined && !timeChanged
      return {
        userId: item.userId,
        optional: item.optional,
        status: keep ? (before.status as AttendeeStatus) : 'needs_action',
        respondedAt: keep ? before.respondedAt : null,
        comment: keep ? before.comment : null,
      }
    }),
    resourceIds,
    linkedObjectIds,
    source: row.source === 'import' ? 'import' : 'local',
    seriesId: row.id,
  })
  await assertResourcesFree(tx, created.id, resourceIds)

  await emit(
    tx,
    ctx,
    { id: row.id, spaceId: loaded.spaceId, title: loaded.title },
    'event.updated',
    {
      calendarId: row.calendarId,
      changed: ['rrule'],
      scope: 'following',
      recurrenceId: iso(recurrenceId),
      timeChanged,
      startsAt: iso(time.startsAt),
    },
  )
  const tailView = { id: created.id, spaceId: calendar.spaceId, title }
  await emit(tx, ctx, tailView, 'event.created', {
    calendarId: calendar.id,
    startsAt: created.startsAt,
    allDay: created.allDay,
    recurring: Boolean(rrule),
  })
  const pending = wanted
    .map((item) => item.userId)
    .filter((userId) => {
      const before = attendees.find((current) => current.userId === userId)
      return !before || timeChanged || before.status === 'needs_action'
    })
  if (pending.length > 0) {
    await emit(tx, ctx, tailView, 'event.invited', { userIds: pending })
    await CalendarInbox.invite(tx, ctx, await nextOccurrence(tx, created), pending)
  }
  await planReminders(tx, [created.id])
  return created.id
}
