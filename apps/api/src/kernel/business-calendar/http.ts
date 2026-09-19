import { BusinessCalendarYear, BusinessDayInput, DateOnly, Timestamp } from '@kchs/contracts'
import { z } from 'zod'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { BusinessCalendar } from './service.js'

const Year = z.coerce.number().int().min(1990).max(2200)

export function registerBusinessCalendarRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/business-calendar',
    auth: 'session',
    tags: ['business-calendar'],
    summary: 'Исключения производственного календаря за год',
    schema: {
      querystring: z.object({ year: Year }),
      response: { 200: BusinessCalendarYear },
    },
    handler: async (request) => BusinessCalendar.year(request.query.year),
  })

  route({
    method: 'GET',
    url: '/business-calendar/deadline',
    auth: 'session',
    tags: ['business-calendar'],
    summary: 'Срок «N рабочих дней»: дата и конец дня в поясе установки',
    schema: {
      querystring: z.object({
        workingDays: z.coerce.number().int().min(0).max(366),
        /** Момент отсчёта; по умолчанию — сейчас. */
        from: Timestamp.optional(),
      }),
      response: { 200: z.object({ date: DateOnly, dueAt: Timestamp }) },
    },
    handler: async (request) => {
      const start = request.query.from ? new Date(request.query.from) : new Date()
      const { date, dueAt } = await BusinessCalendar.deadline(start, request.query.workingDays)
      return { date, dueAt: dueAt.toISOString() }
    },
  })

  route({
    method: 'PUT',
    url: '/admin/business-calendar/:day',
    auth: { capability: 'admin.system' },
    tags: ['business-calendar'],
    summary: 'Задать день: праздник, перенесённый выходной, рабочий или сокращённый',
    schema: {
      params: z.object({ day: DateOnly }),
      body: BusinessDayInput,
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        BusinessCalendar.setDay(tx, request.ctx, request.params.day, request.body),
      )
      return { ok: true }
    },
  })

  route({
    method: 'DELETE',
    url: '/admin/business-calendar/:day',
    auth: { capability: 'admin.system' },
    tags: ['business-calendar'],
    summary: 'Снять исключение: день — по правилу недели',
    schema: {
      params: z.object({ day: DateOnly }),
      response: { 200: z.object({ removed: z.boolean() }) },
    },
    handler: async (request) => ({
      removed: await db().transaction((tx) =>
        BusinessCalendar.clearDay(tx, request.ctx, request.params.day),
      ),
    }),
  })
}
