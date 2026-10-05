import { z } from 'zod'
import {
  ScheduleEnabledInput,
  ScheduleList,
  ScheduleRecord,
  ScheduleRunList,
  ScheduleRunsQuery,
} from '../../automation/schedules.js'
import { defineRoutes } from '../../http/route-contract.js'

const KeyParam = z.object({ key: z.string().min(1).max(200) })

/**
 * Маршруты ядра «schedules» (ADR-0188). Регистрация — `apps/api/src/kernel/schedules/`:
 * http.ts.
 */
export const kernelSchedulesRoutes = defineRoutes({
  'GET /schedules': { response: { 200: ScheduleList } },
  'POST /schedules/:key/enabled': {
    params: KeyParam,
    body: ScheduleEnabledInput,
    response: { 200: ScheduleRecord },
  },
  'POST /schedules/:key/run': {
    params: KeyParam,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'GET /schedules/:key/runs': {
    params: KeyParam,
    query: ScheduleRunsQuery,
    response: { 200: ScheduleRunList },
  },
})
