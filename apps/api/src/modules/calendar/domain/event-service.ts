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
import { and, eq, inArray } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { objects } from '~/kernel/objects/schema.js'
import { hiddenSummary, ObjectService } from '~/kernel/objects/service.js'
import type { UserCtx } from '~/shared/context.js'
import { db, type Executor, type Tx } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { calendars, eventAttendees, eventInstances, events } from '../schema.js'
import { CalendarInbox } from './calendar-inbox.js'
import { loadCalendar, principalUser } from './calendar-service.js'
import {
  assertLinkable,
  assertPeople,
  assertResources,
  assertResourcesFree,
  attendeesOf,
  dedupeAttendees,
  emit,
  insertEvent,
  loadEvent,
  metaOf,
  nextOccurrence,
  organizerFor,
  pickOverrides,
  remindersOf,
  resourceIdsOf,
  ruleOf,
  text,
  timeOf,
  transparencyOf,
  validation,
  writableCalendar,
} from './event-core.js'
import { splitSeries, updateOccurrence, updateSeries } from './event-edit.js'
import { cancelEventMeeting, syncEventMeeting } from './event-meeting.js'
import {
  type EventRow,
  inclusiveEnd,
  materialize,
  rematerializeOccurrence,
  seriesOf,
} from './instances.js'
import { hasOccurrence, type OccurrenceOverride, truncateBefore } from './recurrence.js'
import { dropReminders, planReminders, replanReminders } from './reminders.js'
import { calendarSettings } from './settings.js'
import { iso } from './time.js'

/**
 * События календаря (12-calendar-notifications-home.md §1, ADR-0081): объект
 * реестра и строка события, участники с их правами, бронь ресурсов,
 * материализация экземпляров, приглашения во Входящих, напоминания и события —
 * в одной транзакции.
 */

export const EventService = {
  async create(tx: Tx, ctx: UserCtx, input: EventCreateInput): Promise<string> {
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
  async update(tx: Tx, ctx: UserCtx, id: string, input: EventUpdateInput): Promise<string> {
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
  async cancel(tx: Tx, ctx: UserCtx, id: string, input: EventCancelInput): Promise<void> {
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
  async respond(tx: Tx, ctx: UserCtx, id: string, input: EventRespondInput): Promise<void> {
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
