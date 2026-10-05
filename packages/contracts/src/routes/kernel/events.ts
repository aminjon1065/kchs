import { z } from 'zod'
import { EventDlqList, EventDlqRetryResult } from '../../admin/events.js'
import { defineRoutes } from '../../http/route-contract.js'

const DlqParams = z.object({ id: z.string().regex(/^\d{1,20}-\d{1,20}$/) })

/**
 * Маршруты ядра «events» (ADR-0188). Регистрация — `apps/api/src/kernel/events/`: http.ts.
 */
export const kernelEventsRoutes = defineRoutes({
  'GET /admin/events/dlq': {
    query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
    response: { 200: EventDlqList },
  },
  'POST /admin/events/dlq/:id/retry': { params: DlqParams, response: { 200: EventDlqRetryResult } },
  'POST /admin/events/dlq/retry-all': { response: { 200: EventDlqRetryResult } },
})
