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

/** Маршруты календаря (12-calendar-notifications-home.md §1, ADR-0081). */
export function registerCalendarRoutes(route: RouteRegistrar): void {
  // ─── Календари ────────────────────────────────────────────────────────────
  route({
    route: 'GET /calendars',
    auth: 'session',
    tags: ['calendar'],
    summary: 'Мои календари (личный создаётся при первом обращении) или доступные для добавления',
    handler: async (request) => ({ items: await CalendarService.list(request.ctx, request.query) }),
  })

  route({
    route: 'POST /calendars',
    auth: 'session',
    tags: ['calendar'],
    summary: 'Создать календарь: командный, проектный, ресурс или подписку на ICS',
    handler: async (request) => ({
      id: await db().transaction((tx) => CalendarService.create(tx, request.ctx, request.body)),
    }),
  })

  route({
    route: 'GET /calendars/:id',
    auth: { action: 'view' },
    tags: ['calendar'],
    summary: 'Календарь: вид, цвет, пояс, права',
    handler: async (request) => CalendarService.get(request.ctx, request.params.id),
  })

  route({
    route: 'PATCH /calendars/:id',
    auth: { action: 'manage' },
    tags: ['calendar'],
    summary: 'Изменить календарь: название, цвет, пояс, описание, сведения ресурса',
    handler: async (request) => {
      await db().transaction((tx) =>
        CalendarService.update(tx, request.ctx, request.params.id, request.body),
      )
      return CalendarService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'POST /calendars/:id/import',
    auth: { action: 'import' },
    tags: ['calendar'],
    summary: 'Загрузить события из файла .ics',
    handler: async (request) =>
      IcsService.importInto(request.ctx, request.params.id, request.body.ics),
  })

  route({
    route: 'POST /calendars/:id/sync',
    auth: { action: 'manage' },
    tags: ['calendar'],
    summary: 'Перечитать подписку на внешний календарь',
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
    route: 'GET /calendars/:id/feeds',
    auth: { action: 'view' },
    tags: ['calendar'],
    summary: 'Мои ссылки ICS-подписки на календарь',
    handler: async (request) => ({
      items: await IcsService.listFeeds(request.ctx, request.params.id),
    }),
  })

  route({
    route: 'POST /calendars/:id/feeds',
    auth: { action: 'feed' },
    tags: ['calendar'],
    summary: 'Выпустить ссылку ICS-подписки (адрес показывается один раз)',
    handler: async (request) =>
      db().transaction((tx) => IcsService.createFeed(tx, request.ctx, request.params.id)),
  })

  route({
    route: 'DELETE /calendars/:id/feeds/:feedId',
    auth: { action: 'view' },
    tags: ['calendar'],
    summary: 'Отозвать ссылку ICS-подписки',
    handler: async (request) => {
      await db().transaction((tx) =>
        IcsService.revokeFeed(tx, request.ctx, request.params.id, request.params.feedId),
      )
      return { ok: true }
    },
  })

  // Лента подписки открывается без входа: доступ — секретный токен в адресе
  route({
    route: 'GET /calendar-feeds/:file',
    auth: 'public',
    tags: ['calendar'],
    summary: 'Лента ICS-подписки по секретному токену',
    rateLimit: { max: 60, timeWindow: '1 minute' },
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
    route: 'GET /calendar/settings',
    auth: 'session',
    tags: ['calendar'],
    summary: 'Мои настройки календаря: рабочие часы, напоминания, отметки календарей',
    handler: async (request) => calendarSettings(principalUser(request.ctx)),
  })

  route({
    route: 'PUT /calendar/settings',
    auth: 'session',
    tags: ['calendar'],
    summary: 'Сохранить настройки календаря',
    handler: async (request) =>
      db().transaction((tx) =>
        saveCalendarSettings(tx, request.ctx, principalUser(request.ctx), request.body),
      ),
  })

  route({
    route: 'GET /calendar/projections',
    auth: 'session',
    tags: ['calendar'],
    summary: 'Проекции других модулей: сроки задач и поручений, документов на контроле',
    handler: async () => ({ items: projectionSources() }),
  })

  route({
    route: 'GET /calendar/range',
    auth: 'session',
    tags: ['calendar'],
    summary: 'События календарей в диапазоне и проекции сроков',
    handler: async (request) => RangeService.range(request.ctx, request.query),
  })

  route({
    route: 'GET /calendar/today',
    auth: 'session',
    tags: ['calendar'],
    summary: 'Мои встречи и сроки сегодня — виджет «Сегодня» в «Мой день»',
    handler: async (request) => RangeService.today(request.ctx),
  })

  route({
    route: 'GET /calendar/free-busy',
    auth: 'session',
    tags: ['calendar'],
    summary: 'Занятость сотрудников и ресурсов в диапазоне («занято» без деталей)',
    handler: async (request) => RangeService.freeBusy(request.ctx, request.query),
  })

  route({
    route: 'POST /calendar/find-time',
    auth: 'session',
    tags: ['calendar'],
    summary: 'Свободные окна для встречи: участники, ресурсы, рабочие часы и дни',
    readOnly: true,
    handler: async (request) => RangeService.findTime(request.ctx, request.body),
  })

  // ─── События ─────────────────────────────────────────────────────────────
  route({
    route: 'POST /events',
    auth: 'session',
    tags: ['calendar'],
    summary: 'Создать событие: время или весь день, повтор, участники, ресурсы, напоминания',
    handler: async (request) => ({
      id: await db().transaction((tx) => EventService.create(tx, request.ctx, request.body)),
    }),
  })

  route({
    route: 'GET /events/:id',
    auth: { action: 'view' },
    tags: ['calendar'],
    summary: 'Событие: время, повтор, участники с ответами, ресурсы; экземпляр — по recurrenceId',
    handler: async (request) =>
      EventService.get(request.ctx, request.params.id, request.query.recurrenceId),
  })

  route({
    route: 'PATCH /events/:id',
    auth: { action: 'edit' },
    tags: ['calendar'],
    summary: 'Изменить событие: экземпляр, «это и следующие» или всю серию',
    handler: async (request) => ({
      id: await db().transaction((tx) =>
        EventService.update(tx, request.ctx, request.params.id, request.body),
      ),
    }),
  })

  route({
    route: 'POST /events/:id/cancel',
    auth: { action: 'edit' },
    tags: ['calendar'],
    summary: 'Отменить событие, экземпляр или «это и следующие»',
    handler: async (request) => {
      await db().transaction((tx) =>
        EventService.cancel(tx, request.ctx, request.params.id, request.body),
      )
      return { ok: true }
    },
  })

  route({
    route: 'POST /events/:id/respond',
    auth: { action: 'view' },
    tags: ['calendar'],
    summary: 'Ответить на приглашение: да, возможно, нет, другое время',
    handler: async (request) => {
      await db().transaction((tx) =>
        EventService.respond(tx, request.ctx, request.params.id, request.body),
      )
      return EventService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'PUT /events/:id/my-reminders',
    auth: { action: 'view' },
    tags: ['calendar'],
    summary: 'Мои напоминания о событии (null — как у события)',
    handler: async (request) => {
      await db().transaction((tx) =>
        EventService.setMyReminders(tx, request.ctx, request.params.id, request.body.reminders),
      )
      return { ok: true }
    },
  })
}
