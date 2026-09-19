import {
  type AttendeeStatus,
  atLeast,
  type BusinessDayKind,
  type BusyInterval,
  type CalendarColor,
  type CalendarProjectionItem,
  type CalendarRange,
  type CalendarRangeItem,
  type CalendarRangeQuery,
  type EventShowAs,
  type EventVisibility,
  type FindTimeInput,
  type FindTimeResult,
  type FreeBusyQuery,
  type FreeBusyResult,
  type Level,
  type ResourceKind,
  type UserRef,
} from '@kchs/contracts'
import { and, eq, inArray, or, type SQL, sql } from 'drizzle-orm'
import { authorize, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { BusinessCalendar } from '~/kernel/business-calendar/service.js'
import { isWorkingDate } from '~/kernel/business-calendar/working-days.js'
import { directory } from '~/kernel/directory/port.js'
import { UserService } from '~/modules/identity/public.js'
import { config } from '~/shared/config/index.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import {
  eventAttendees,
  eventInstances,
  eventResources,
  events,
  type OccurrenceOverrideValue,
  objects,
} from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import {
  type CalendarRow,
  CalendarService,
  loadCalendar,
  principalUser,
} from './calendar-service.js'
import { findSlots } from './find-time.js'
import { inclusiveEnd, overlaps } from './instances.js'
import { projectionProviders } from './projections.js'
import { calendarSettings, workingHoursOf } from './settings.js'
import { addDays, iso, localDate, startOfDate } from './time.js'

/** Предел экземпляров в одном ответе диапазона. */
const RANGE_LIMIT = 2000

interface DetailSubject {
  eventId: string
  visibility: string
  calendarId: string
}

/**
 * Кому видны детали события (ADR-0081): участникам всегда; открытого — всем,
 * кто видит событие (права ядра, наследуемые от календаря); «занято» — ещё и
 * тем, кто правит календарь; «личное» — только участникам, даже администратору.
 */
export async function detailedEvents(
  ctx: UserCtx,
  subjects: DetailSubject[],
  editableCalendars: Set<string>,
): Promise<Set<string>> {
  const ids = [...new Set(subjects.map((item) => item.eventId))]
  if (ids.length === 0) return new Set()
  const me = [...new Set([principalUser(ctx), ctx.userId])]
  const participant = await db()
    .select({ eventId: eventAttendees.eventId })
    .from(eventAttendees)
    .where(and(inArray(eventAttendees.eventId, ids), inArray(eventAttendees.userId, me)))
  const detailed = new Set(participant.map((row) => row.eventId))
  const publicIds = [
    ...new Set(
      subjects
        .filter((item) => item.visibility === 'public' && !detailed.has(item.eventId))
        .map((item) => item.eventId),
    ),
  ]
  if (publicIds.length > 0) {
    const visible = await db()
      .select({ id: objects.id })
      .from(objects)
      .where(and(inArray(objects.id, publicIds), visibleObjectsSql(ctx, 'event')))
    for (const row of visible) detailed.add(row.id)
  }
  for (const item of subjects) {
    if (item.visibility === 'busy' && editableCalendars.has(item.calendarId)) {
      detailed.add(item.eventId)
    }
  }
  return detailed
}

function idsOf(value: string | undefined): string[] | null {
  if (!value) return null
  return [...new Set(value.split(',').filter(Boolean))]
}

function overrideOf(overrides: unknown, recurrenceId: string): OccurrenceOverrideValue | null {
  return (overrides as Record<string, OccurrenceOverrideValue> | null)?.[recurrenceId] ?? null
}

/** Рабочие дни производственного календаря для подбора времени и затенения. */
async function workingDayOf(from: number, to: number): Promise<(date: string) => boolean> {
  const first = new Date(from).getUTCFullYear() - 1
  const last = new Date(to).getUTCFullYear() + 1
  const kinds = new Map<string, BusinessDayKind>()
  for (let year = first; year <= last; year++) {
    for (const day of (await BusinessCalendar.year(year)).days) kinds.set(day.day, day.kind)
  }
  return (date) => isWorkingDate(date, (day) => kinds.get(day))
}

export const RangeService = {
  /**
   * Экземпляры отмеченных календарей в диапазоне (и мои приглашения, если
   * показан мой личный календарь) плюс проекции других модулей.
   */
  async range(ctx: UserCtx, query: CalendarRangeQuery): Promise<CalendarRange> {
    const me = principalUser(ctx)
    const personalId =
      (await CalendarService.personalId(me)) ??
      (await db().transaction((tx) => CalendarService.ensurePersonal(tx, ctx, me)))
    const requested = query.mine ? [personalId] : idsOf(query.calendarIds)
    const resolved = await CalendarService.resolve(ctx, requested)
    const byId = new Map(resolved.map((item) => [item.row.id, item]))
    const calendarIds = [...byId.keys()]
    const withInvites = byId.has(personalId)
    const personal = byId.get(personalId)?.row ?? (await loadCalendar(db(), personalId))
    const editable = new Set(
      resolved.filter((item) => atLeast(item.level, 'edit')).map((item) => item.row.id),
    )

    const scope: SQL[] = []
    if (calendarIds.length > 0) scope.push(inArray(eventInstances.calendarId, calendarIds))
    if (withInvites) {
      scope.push(
        sql`${eventInstances.eventId} IN (SELECT a.event_id FROM ${eventAttendees} a
              WHERE a.user_id = ${me} AND a.role = 'attendee' AND a.status <> 'declined')`,
      )
    }
    const rows =
      scope.length === 0
        ? []
        : await db()
            .select({
              instanceId: eventInstances.id,
              eventId: eventInstances.eventId,
              calendarId: eventInstances.calendarId,
              recurrenceId: eventInstances.recurrenceId,
              startsAt: eventInstances.startsAt,
              endsAt: eventInstances.endsAt,
              allDay: eventInstances.allDay,
              startDate: eventInstances.startDate,
              endDate: eventInstances.endDate,
              rrule: events.rrule,
              visibility: events.visibility,
              transparency: events.transparency,
              color: events.color,
              location: events.location,
              organizerId: events.organizerId,
              meetingId: events.meetingId,
              source: events.source,
              overrides: events.overrides,
              title: objects.title,
            })
            .from(eventInstances)
            .innerJoin(events, eq(events.id, eventInstances.eventId))
            .innerJoin(objects, eq(objects.id, events.id))
            .where(
              and(sql`${objects.deletedAt} IS NULL`, overlaps(query.from, query.to), or(...scope)),
            )
            .orderBy(eventInstances.startsAt)
            .limit(RANGE_LIMIT + 1)
    const truncated = rows.length > RANGE_LIMIT
    const page = truncated ? rows.slice(0, RANGE_LIMIT) : rows

    const detailed = await detailedEvents(ctx, page, editable)
    const eventIds = [...new Set(page.map((row) => row.eventId))]
    const attendance = eventIds.length
      ? await db()
          .select({
            eventId: eventAttendees.eventId,
            userId: eventAttendees.userId,
            role: eventAttendees.role,
            status: eventAttendees.status,
          })
          .from(eventAttendees)
          .where(inArray(eventAttendees.eventId, eventIds))
      : []
    const counts = new Map<string, number>()
    const mine = new Map<string, { role: string; status: string }>()
    for (const row of attendance) {
      counts.set(row.eventId, (counts.get(row.eventId) ?? 0) + 1)
      if (row.userId === me) mine.set(row.eventId, row)
    }
    const organizers = await directory().refs([
      ...new Set(
        page
          .filter((row) => detailed.has(row.eventId))
          .map((row) => row.organizerId)
          .filter((id): id is string => Boolean(id)),
      ),
    ])
    // Календари приглашений вне выборки — только их цвет не нужен: приглашение красится моим
    const colorOf = (row: (typeof page)[number], invitation: boolean): CalendarColor => {
      if (row.color) return row.color as CalendarColor
      if (invitation && personal) return personal.color as CalendarColor
      return (byId.get(row.calendarId)?.row.color as CalendarColor | undefined) ?? 'blue'
    }

    const items: CalendarRangeItem[] = page.map((row) => {
      const invitation = !byId.has(row.calendarId)
      const showAs: EventShowAs = row.transparency === 'transparent' ? 'free' : 'busy'
      const common = {
        calendarId: invitation && personal ? personal.id : row.calendarId,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        allDay: row.allDay,
        startDate: row.startDate,
        endDate: inclusiveEnd(row.endDate),
        showAs,
        invitation,
      }
      if (!detailed.has(row.eventId)) {
        return {
          ...common,
          key: `busy:${row.instanceId}`,
          eventId: null,
          recurrenceId: null,
          recurring: false,
          busy: true,
          title: null,
          location: null,
          color: colorOf(row, invitation),
          visibility: null,
          myStatus: null,
          organizer: null,
          attendeeCount: 0,
          hasMeeting: false,
          canEdit: false,
        }
      }
      const change = overrideOf(row.overrides, row.recurrenceId)
      const attendee = mine.get(row.eventId)
      const level: Level | undefined = byId.get(row.calendarId)?.level
      return {
        ...common,
        key: `${row.eventId}:${row.recurrenceId}`,
        eventId: row.eventId,
        recurrenceId: row.rrule ? row.recurrenceId : null,
        recurring: Boolean(row.rrule),
        busy: false,
        title: change?.title ?? row.title,
        location: change && change.location !== undefined ? change.location : row.location,
        color: colorOf(row, invitation),
        visibility: row.visibility as EventVisibility,
        myStatus: (attendee?.status as AttendeeStatus | undefined) ?? null,
        organizer: row.organizerId ? (organizers.get(row.organizerId) ?? null) : null,
        attendeeCount: counts.get(row.eventId) ?? 0,
        hasMeeting: Boolean(row.meetingId),
        canEdit:
          row.source !== 'subscription' &&
          (attendee?.role === 'organizer' || (level !== undefined && atLeast(level, 'edit'))),
      }
    })

    const projections = await projectionsFor(ctx, query)
    return { items, projections, truncated }
  },

  /**
   * Занятость участников и ресурсов (подбор времени): интервалы «занят» или
   * «возможно»; название — только если детали события видны запрашивающему.
   */
  async freeBusy(ctx: UserCtx, query: FreeBusyQuery): Promise<FreeBusyResult> {
    const userIds = (idsOf(query.userIds) ?? []).slice(0, 50)
    const resourceIds = (idsOf(query.resourceIds) ?? []).slice(0, 10)
    const from = Date.parse(query.from)
    const to = Date.parse(query.to)
    const exclude = query.excludeEventId ? sql`AND e.id <> ${query.excludeEventId}` : sql``

    const [refs, hours] = await Promise.all([directory().refs(userIds), workingHoursOf(userIds)])
    const people = userIds.filter((id) => refs.has(id))
    const busyRows = people.length
      ? await db().execute<{
          user_id: string
          role: string
          status: string
          event_id: string
          visibility: string
          calendar_id: string
          title: string
          starts_at: string | Date
          ends_at: string | Date
        }>(sql`
          SELECT a.user_id, a.role, a.status, e.id AS event_id, e.visibility, e.calendar_id,
                 o.title, i.starts_at, i.ends_at
            FROM ${eventAttendees} a
            JOIN ${events} e ON e.id = a.event_id AND e.transparency = 'opaque'
            JOIN ${objects} o ON o.id = e.id AND o.deleted_at IS NULL
            JOIN ${eventInstances} i ON i.event_id = e.id
           WHERE a.user_id IN (${sql.join(
             people.map((id) => sql`${id}`),
             sql`, `,
           )})
             AND a.status <> 'declined'
             AND tstzrange(i.starts_at, i.ends_at, '[)') && tstzrange(${query.from}::timestamptz, ${query.to}::timestamptz, '[)')
             ${exclude}
           ORDER BY i.starts_at
           LIMIT 5000`)
      : []

    const resources: CalendarRow[] = []
    for (const id of resourceIds) {
      const row = await loadCalendar(db(), id)
      if (row?.kind !== 'resource') continue
      const decision = await authorize(ctx, 'view', id, { soft: true })
      if (decision.allowed) resources.push(row)
    }
    const resourceRows = resources.length
      ? await db().execute<{
          resource_id: string
          event_id: string
          visibility: string
          calendar_id: string
          title: string
          starts_at: string | Date
          ends_at: string | Date
        }>(sql`
          SELECT r.resource_id, e.id AS event_id, e.visibility, e.calendar_id, o.title,
                 i.starts_at, i.ends_at
            FROM ${eventResources} r
            JOIN ${events} e ON e.id = r.event_id
            JOIN ${objects} o ON o.id = e.id AND o.deleted_at IS NULL
            JOIN ${eventInstances} i ON i.event_id = e.id
           WHERE r.resource_id IN (${sql.join(
             resources.map((row) => sql`${row.id}`),
             sql`, `,
           )})
             AND r.status = 'accepted'
             AND tstzrange(i.starts_at, i.ends_at, '[)') && tstzrange(${query.from}::timestamptz, ${query.to}::timestamptz, '[)')
             ${exclude}
           ORDER BY i.starts_at
           LIMIT 5000`)
      : []

    const detailed = await detailedEvents(
      ctx,
      [...busyRows, ...resourceRows].map((row) => ({
        eventId: row.event_id,
        visibility: row.visibility,
        calendarId: row.calendar_id,
      })),
      new Set(),
    )
    const interval = (
      row: { event_id: string; title: string; starts_at: string | Date; ends_at: string | Date },
      status: BusyInterval['status'],
    ): BusyInterval => ({
      startsAt: new Date(row.starts_at).toISOString(),
      endsAt: new Date(row.ends_at).toISOString(),
      status,
      title: detailed.has(row.event_id) ? row.title : null,
    })

    const timezones = new Map<string, string>()
    for (const id of people) {
      timezones.set(id, (await UserService.profile(id))?.timezone ?? config().TZ)
    }
    const workingDay = await workingDayOf(from, to)
    const nonWorkingDays: string[] = []
    for (
      let date = localDate(from, config().TZ);
      date <= localDate(to - 1, config().TZ);
      date = addDays(date, 1)
    ) {
      if (!workingDay(date)) nonWorkingDays.push(date)
    }

    return {
      people: people.map((id) => ({
        user: refs.get(id) as UserRef,
        timezone: timezones.get(id) ?? config().TZ,
        workingHours: hours.get(id) ?? { start: '09:00', end: '18:00' },
        busy: busyRows
          .filter((row) => row.user_id === id)
          .map((row) =>
            interval(
              row,
              row.role === 'organizer' || row.status === 'accepted' ? 'busy' : 'tentative',
            ),
          ),
      })),
      resources: resources.map((row) => {
        const info = row.resource as { kind?: string; location?: string | null } | null
        return {
          resource: {
            id: row.id,
            title: row.title,
            kind: (info?.kind ?? 'room') as ResourceKind,
            location: info?.location ?? null,
            color: row.color as CalendarColor,
          },
          busy: resourceRows
            .filter((item) => item.resource_id === row.id)
            .map((item) => interval(item, 'busy')),
        }
      }),
      nonWorkingDays,
    }
  },

  /** Предложения свободных окон: обязательные участники (и я), ресурсы, рабочие часы и дни. */
  async findTime(ctx: UserCtx, input: FindTimeInput): Promise<FindTimeResult> {
    const me = principalUser(ctx)
    const optional = [...new Set(input.optionalUserIds)].filter((id) => id !== me)
    const required = [...new Set([me, ...input.userIds])].filter((id) => !optional.includes(id))
    const freeBusy = await RangeService.freeBusy(ctx, {
      from: input.from,
      to: input.to,
      userIds: [...required, ...optional].join(','),
      ...(input.resourceIds.length ? { resourceIds: input.resourceIds.join(',') } : {}),
      ...(input.excludeEventId ? { excludeEventId: input.excludeEventId } : {}),
    })
    const from = Date.parse(input.from)
    const to = Date.parse(input.to)
    const workingDay = await workingDayOf(from, to)
    const personOf = (id: string) => {
      const person = freeBusy.people.find((item) => item.user.id === id)
      return {
        timezone: person?.timezone ?? config().TZ,
        workingHours: person?.workingHours ?? { start: '09:00', end: '18:00' },
        // «Возможно» тоже занимает время: предлагаем только свободное
        busy: (person?.busy ?? []).map((item) => ({
          start: Date.parse(item.startsAt),
          end: Date.parse(item.endsAt),
        })),
      }
    }
    const slots = findSlots({
      from,
      to,
      durationMs: input.durationMinutes * 60_000,
      stepMinutes: 30,
      notBefore: Date.now(),
      required: required
        .filter((id) => freeBusy.people.some((p) => p.user.id === id))
        .map(personOf),
      optional: optional
        .filter((id) => freeBusy.people.some((p) => p.user.id === id))
        .map(personOf),
      resources: freeBusy.resources.map((resource) =>
        resource.busy.map((item) => ({
          start: Date.parse(item.startsAt),
          end: Date.parse(item.endsAt),
        })),
      ),
      workingHoursOnly: input.workingHoursOnly,
      isWorkingDay: workingDay,
      timezone: ctx.timezone,
      limit: input.limit,
      perDay: 3,
    })
    return {
      slots: slots.map((slot) => ({
        startsAt: iso(slot.start),
        endsAt: iso(slot.end),
        optionalBusy: slot.optionalBusy,
      })),
      freeBusy,
    }
  },

  /** «Сегодня» для «Мой день»: мои события и приглашения дня в моём поясе и сроки дня. */
  async today(ctx: UserCtx): Promise<CalendarRange> {
    const date = localDate(Date.now(), ctx.timezone)
    return RangeService.range(ctx, {
      from: iso(startOfDate(date, ctx.timezone)),
      to: iso(startOfDate(addDays(date, 1), ctx.timezone)),
      mine: true,
    })
  },
}

/** Проекции включённых поставщиков; сбой одного не ломает календарь. */
async function projectionsFor(
  ctx: UserCtx,
  query: CalendarRangeQuery,
): Promise<CalendarProjectionItem[]> {
  const settings = await calendarSettings(principalUser(ctx))
  const requested =
    query.projections !== undefined ? query.projections.split(',') : settings.projections
  const providers = projectionProviders().filter(
    (provider) => requested === null || requested.includes(provider.key),
  )
  const result: CalendarProjectionItem[] = []
  for (const provider of providers) {
    try {
      const items = await provider.list(ctx, {
        from: new Date(query.from),
        to: new Date(query.to),
        timezone: ctx.timezone,
      })
      for (const item of items) {
        result.push({ ...item, key: `${provider.key}:${item.objectId}`, provider: provider.key })
      }
    } catch (error) {
      logger().warn({ err: error, provider: provider.key }, 'проекция календаря не получена')
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date))
}
