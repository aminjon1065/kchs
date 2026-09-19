import {
  CalendarCreateInput,
  CalendarFeed,
  CalendarFeedCreated,
  CalendarImportInput,
  CalendarImportResult,
  CalendarList,
  CalendarListQuery,
  CalendarProjectionSource,
  CalendarRange,
  CalendarRangeQuery,
  CalendarRecord,
  CalendarSettings,
  CalendarSettingsInput,
  CalendarUpdateInput,
  EventCancelInput,
  EventCreateInput,
  EventRecord,
  EventRemindersInput,
  EventRespondInput,
  EventUpdateInput,
  FindTimeInput,
  FindTimeResult,
  FreeBusyQuery,
  FreeBusyResult,
  Timestamp,
} from '@kchs/contracts'
import { z } from 'zod'
import { JobService } from '~/kernel/jobs/service.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import {
  CALENDAR_SYNC_JOB,
  CalendarService,
  loadCalendar,
  principalUser,
} from './domain/calendar-service.js'
import { EventService } from './domain/event-service.js'
import { IcsService } from './domain/ics-service.js'
import { projectionSources } from './domain/projections.js'
import { RangeService } from './domain/range-service.js'
import { calendarSettings, saveCalendarSettings } from './domain/settings.js'

const IdParam = z.object({ id: z.uuid() })

/** Маршруты календаря (12-calendar-notifications-home.md §1, ADR-0081). */
export function registerCalendarRoutes(route: RouteRegistrar): void {
  // ─── Календари ────────────────────────────────────────────────────────────
  route({
    method: 'GET',
    url: '/calendars',
    auth: 'session',
    tags: ['calendar'],
    summary: 'Мои календари (личный создаётся при первом обращении) или доступные для добавления',
    schema: { querystring: CalendarListQuery, response: { 200: CalendarList } },
    handler: async (request) => ({ items: await CalendarService.list(request.ctx, request.query) }),
  })

  route({
    method: 'POST',
    url: '/calendars',
    auth: 'session',
    tags: ['calendar'],
    summary: 'Создать календарь: командный, проектный, ресурс или подписку на ICS',
    schema: { body: CalendarCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => ({
      id: await db().transaction((tx) => CalendarService.create(tx, request.ctx, request.body)),
    }),
  })

  route({
    method: 'GET',
    url: '/calendars/:id',
    auth: { action: 'view' },
    tags: ['calendar'],
    summary: 'Календарь: вид, цвет, пояс, права',
    schema: { params: IdParam, response: { 200: CalendarRecord } },
    handler: async (request) => CalendarService.get(request.ctx, request.params.id),
  })

  route({
    method: 'PATCH',
    url: '/calendars/:id',
    auth: { action: 'manage' },
    tags: ['calendar'],
    summary: 'Изменить календарь: название, цвет, пояс, описание, сведения ресурса',
    schema: { params: IdParam, body: CalendarUpdateInput, response: { 200: CalendarRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        CalendarService.update(tx, request.ctx, request.params.id, request.body),
      )
      return CalendarService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/calendars/:id/import',
    auth: { action: 'import' },
    tags: ['calendar'],
    summary: 'Загрузить события из файла .ics',
    schema: { params: IdParam, body: CalendarImportInput, response: { 200: CalendarImportResult } },
    handler: async (request) =>
      IcsService.importInto(request.ctx, request.params.id, request.body.ics),
  })

  route({
    method: 'POST',
    url: '/calendars/:id/sync',
    auth: { action: 'manage' },
    tags: ['calendar'],
    summary: 'Перечитать подписку на внешний календарь',
    schema: { params: IdParam, response: { 200: z.object({ jobId: z.uuid() }) } },
    handler: async (request) => {
      const calendar = await loadCalendar(db(), request.params.id)
      if (calendar?.kind !== 'subscription') {
        throw errors.validation('Перечитать можно только подписку на внешний календарь')
      }
      const jobId = await JobService.enqueue(request.ctx, {
        ...CALENDAR_SYNC_JOB,
        data: { calendarId: calendar.id },
        objectId: calendar.id,
        idempotencyKey: `calendar.sync:${calendar.id}:manual:${Date.now()}`,
      })
      return { jobId }
    },
  })

  route({
    method: 'GET',
    url: '/calendars/:id/feeds',
    auth: { action: 'view' },
    tags: ['calendar'],
    summary: 'Мои ссылки ICS-подписки на календарь',
    schema: { params: IdParam, response: { 200: z.object({ items: z.array(CalendarFeed) }) } },
    handler: async (request) => ({
      items: await IcsService.listFeeds(request.ctx, request.params.id),
    }),
  })

  route({
    method: 'POST',
    url: '/calendars/:id/feeds',
    auth: { action: 'feed' },
    tags: ['calendar'],
    summary: 'Выпустить ссылку ICS-подписки (адрес показывается один раз)',
    schema: { params: IdParam, response: { 200: CalendarFeedCreated } },
    handler: async (request) =>
      db().transaction((tx) => IcsService.createFeed(tx, request.ctx, request.params.id)),
  })

  route({
    method: 'DELETE',
    url: '/calendars/:id/feeds/:feedId',
    auth: { action: 'view' },
    tags: ['calendar'],
    summary: 'Отозвать ссылку ICS-подписки',
    schema: {
      params: z.object({ id: z.uuid(), feedId: z.uuid() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        IcsService.revokeFeed(tx, request.ctx, request.params.id, request.params.feedId),
      )
      return { ok: true }
    },
  })

  // Лента подписки открывается без входа: доступ — секретный токен в адресе
  route({
    method: 'GET',
    url: '/calendar-feeds/:file',
    auth: 'public',
    tags: ['calendar'],
    summary: 'Лента ICS-подписки по секретному токену',
    rateLimit: { max: 60, timeWindow: '1 minute' },
    schema: { params: z.object({ file: z.string().max(200) }) },
    handler: async (request, reply) => {
      const token = request.params.file.replace(/\.ics$/i, '')
      const text = await IcsService.feedByToken(token)
      if (text === null) throw errors.notFound()
      reply
        .header('content-type', 'text/calendar; charset=utf-8')
        .header('cache-control', 'private, max-age=60')
        .header('content-disposition', 'inline; filename="calendar.ics"')
      return text
    },
  })

  // ─── Настройки, проекции, диапазон ───────────────────────────────────────
  route({
    method: 'GET',
    url: '/calendar/settings',
    auth: 'session',
    tags: ['calendar'],
    summary: 'Мои настройки календаря: рабочие часы, напоминания, отметки календарей',
    schema: { response: { 200: CalendarSettings } },
    handler: async (request) => calendarSettings(principalUser(request.ctx)),
  })

  route({
    method: 'PUT',
    url: '/calendar/settings',
    auth: 'session',
    tags: ['calendar'],
    summary: 'Сохранить настройки календаря',
    schema: { body: CalendarSettingsInput, response: { 200: CalendarSettings } },
    handler: async (request) =>
      db().transaction((tx) =>
        saveCalendarSettings(tx, request.ctx, principalUser(request.ctx), request.body),
      ),
  })

  route({
    method: 'GET',
    url: '/calendar/projections',
    auth: 'session',
    tags: ['calendar'],
    summary: 'Проекции других модулей: сроки задач и поручений, документов на контроле',
    schema: { response: { 200: z.object({ items: z.array(CalendarProjectionSource) }) } },
    handler: async () => ({ items: projectionSources() }),
  })

  route({
    method: 'GET',
    url: '/calendar/range',
    auth: 'session',
    tags: ['calendar'],
    summary: 'События календарей в диапазоне и проекции сроков',
    schema: { querystring: CalendarRangeQuery, response: { 200: CalendarRange } },
    handler: async (request) => RangeService.range(request.ctx, request.query),
  })

  route({
    method: 'GET',
    url: '/calendar/today',
    auth: 'session',
    tags: ['calendar'],
    summary: 'Мои встречи и сроки сегодня — виджет «Сегодня» в «Мой день»',
    schema: { response: { 200: CalendarRange } },
    handler: async (request) => RangeService.today(request.ctx),
  })

  route({
    method: 'GET',
    url: '/calendar/free-busy',
    auth: 'session',
    tags: ['calendar'],
    summary: 'Занятость сотрудников и ресурсов в диапазоне («занято» без деталей)',
    schema: { querystring: FreeBusyQuery, response: { 200: FreeBusyResult } },
    handler: async (request) => RangeService.freeBusy(request.ctx, request.query),
  })

  route({
    method: 'POST',
    url: '/calendar/find-time',
    auth: 'session',
    tags: ['calendar'],
    summary: 'Свободные окна для встречи: участники, ресурсы, рабочие часы и дни',
    readOnly: true,
    schema: { body: FindTimeInput, response: { 200: FindTimeResult } },
    handler: async (request) => RangeService.findTime(request.ctx, request.body),
  })

  // ─── События ─────────────────────────────────────────────────────────────
  route({
    method: 'POST',
    url: '/events',
    auth: 'session',
    tags: ['calendar'],
    summary: 'Создать событие: время или весь день, повтор, участники, ресурсы, напоминания',
    schema: { body: EventCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => ({
      id: await db().transaction((tx) => EventService.create(tx, request.ctx, request.body)),
    }),
  })

  route({
    method: 'GET',
    url: '/events/:id',
    auth: { action: 'view' },
    tags: ['calendar'],
    summary: 'Событие: время, повтор, участники с ответами, ресурсы; экземпляр — по recurrenceId',
    schema: {
      params: IdParam,
      querystring: z.object({ recurrenceId: Timestamp.optional() }),
      response: { 200: EventRecord },
    },
    handler: async (request) =>
      EventService.get(request.ctx, request.params.id, request.query.recurrenceId),
  })

  route({
    method: 'PATCH',
    url: '/events/:id',
    auth: { action: 'edit' },
    tags: ['calendar'],
    summary: 'Изменить событие: экземпляр, «это и следующие» или всю серию',
    schema: {
      params: IdParam,
      body: EventUpdateInput,
      response: { 200: z.object({ id: z.uuid() }) },
    },
    handler: async (request) => ({
      id: await db().transaction((tx) =>
        EventService.update(tx, request.ctx, request.params.id, request.body),
      ),
    }),
  })

  route({
    method: 'POST',
    url: '/events/:id/cancel',
    auth: { action: 'edit' },
    tags: ['calendar'],
    summary: 'Отменить событие, экземпляр или «это и следующие»',
    schema: {
      params: IdParam,
      body: EventCancelInput,
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        EventService.cancel(tx, request.ctx, request.params.id, request.body),
      )
      return { ok: true }
    },
  })

  route({
    method: 'POST',
    url: '/events/:id/respond',
    auth: { action: 'view' },
    tags: ['calendar'],
    summary: 'Ответить на приглашение: да, возможно, нет, другое время',
    schema: { params: IdParam, body: EventRespondInput, response: { 200: EventRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        EventService.respond(tx, request.ctx, request.params.id, request.body),
      )
      return EventService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'PUT',
    url: '/events/:id/my-reminders',
    auth: { action: 'view' },
    tags: ['calendar'],
    summary: 'Мои напоминания о событии (null — как у события)',
    schema: {
      params: IdParam,
      body: EventRemindersInput,
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        EventService.setMyReminders(tx, request.ctx, request.params.id, request.body.reminders),
      )
      return { ok: true }
    },
  })
}
