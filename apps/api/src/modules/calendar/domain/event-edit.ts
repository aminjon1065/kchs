import type {
  AttendeeStatus,
  CalendarColor,
  EventUpdateInput,
  EventVisibility,
} from '@kchs/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { grantAccess, revokeAccess, setAccessMode } from '~/kernel/access/acl-service.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import type { UserCtx } from '~/shared/context.js'
import type { Tx } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { eventAttendees, eventResources, events } from '../schema.js'
import { CalendarInbox } from './calendar-inbox.js'
import { loadCalendar } from './calendar-service.js'
import {
  ATTENDEE_LEVEL,
  assertLinkable,
  assertPeople,
  assertResources,
  assertResourcesFree,
  attendeesOf,
  dedupeAttendees,
  emit,
  insertEvent,
  type LoadedEvent,
  metaOf,
  nextOccurrence,
  pickOverrides,
  remindersOf,
  resourceIdsOf,
  ruleOf,
  sameTime,
  text,
  timeOf,
  timeOfOccurrence,
  transparencyOf,
  validation,
  writableCalendar,
} from './event-core.js'
import { syncEventMeeting } from './event-meeting.js'
import { type EventRow, materialize, rematerializeOccurrence, seriesOf } from './instances.js'
import {
  hasOccurrence,
  type OccurrenceOverride,
  occurrenceOf,
  shiftSeriesKeys,
  tailRule,
  truncateBefore,
} from './recurrence.js'
import { dropReminders, planReminders, replanReminders } from './reminders.js'
import { iso } from './time.js'

/**
 * Правка события (ADR-0081): один экземпляр серии, событие или серия целиком, «этот и
 * следующие» — разрез серии на две.
 */

/** Правка одного экземпляра серии: время, название, место, описание. */
export async function updateOccurrence(
  tx: Tx,
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
export async function updateSeries(
  tx: Tx,
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
export async function splitSeries(
  tx: Tx,
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
