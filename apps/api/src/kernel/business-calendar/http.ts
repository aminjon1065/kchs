import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { BusinessCalendar } from './service.js'

export function registerBusinessCalendarRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /business-calendar',
    auth: 'session',
    tags: ['business-calendar'],
    summary: 'Исключения производственного календаря за год',
    handler: async (request) => BusinessCalendar.year(request.query.year),
  })

  route({
    route: 'GET /business-calendar/deadline',
    auth: 'session',
    tags: ['business-calendar'],
    summary: 'Срок «N рабочих дней»: дата и конец дня в поясе установки',
    handler: async (request) => {
      const start = request.query.from ? new Date(request.query.from) : new Date()
      const { date, dueAt } = await BusinessCalendar.deadline(start, request.query.workingDays)
      return { date, dueAt: dueAt.toISOString() }
    },
  })

  route({
    route: 'PUT /admin/business-calendar/:day',
    auth: { capability: 'admin.system' },
    tags: ['business-calendar'],
    summary: 'Задать день: праздник, перенесённый выходной, рабочий или сокращённый',
    handler: async (request) => {
      await db().transaction((tx) =>
        BusinessCalendar.setDay(tx, request.ctx, request.params.day, request.body),
      )
      return { ok: true }
    },
  })

  route({
    route: 'DELETE /admin/business-calendar/:day',
    auth: { capability: 'admin.system' },
    tags: ['business-calendar'],
    summary: 'Снять исключение: день — по правилу недели',
    handler: async (request) => ({
      removed: await db().transaction((tx) =>
        BusinessCalendar.clearDay(tx, request.ctx, request.params.day),
      ),
    }),
  })
}
