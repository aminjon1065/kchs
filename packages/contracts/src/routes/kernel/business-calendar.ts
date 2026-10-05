import { z } from 'zod'
import { BusinessCalendarYear, BusinessDayInput } from '../../admin/business-calendar.js'
import { DateOnly, Timestamp } from '../../common/primitives.js'
import { defineRoutes } from '../../http/route-contract.js'

const Year = z.coerce.number().int().min(1990).max(2200)

/**
 * Маршруты ядра «business-calendar» (ADR-0188). Регистрация —
 * `apps/api/src/kernel/business-calendar/`: http.ts.
 */
export const kernelBusinessCalendarRoutes = defineRoutes({
  'GET /business-calendar': {
    query: z.object({ year: Year }),
    response: { 200: BusinessCalendarYear },
  },
  'GET /business-calendar/deadline': {
    query: z.object({
      workingDays: z.coerce.number().int().min(0).max(366),
      /** Момент отсчёта; по умолчанию — сейчас. */
      from: Timestamp.optional(),
    }),
    response: { 200: z.object({ date: DateOnly, dueAt: Timestamp }) },
  },
  'PUT /admin/business-calendar/:day': {
    params: z.object({ day: DateOnly }),
    body: BusinessDayInput,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'DELETE /admin/business-calendar/:day': {
    params: z.object({ day: DateOnly }),
    response: { 200: z.object({ removed: z.boolean() }) },
  },
})
