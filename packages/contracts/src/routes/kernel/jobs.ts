import { z } from 'zod'
import { ENGINE_CALLBACKS } from '../../engine/callbacks.js'
import { defineRoutes } from '../../http/route-contract.js'
import { JobRecord } from '../../jobs/job.js'

/**
 * Маршруты ядра «jobs» (ADR-0188). Регистрация — `apps/api/src/kernel/jobs/`: http.ts,
 * internal-http.ts.
 */
export const kernelJobsRoutes = defineRoutes({
  'GET /jobs': {
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
    response: { 200: z.object({ items: z.array(JobRecord) }) },
  },
  'GET /jobs/:id': { params: z.object({ id: z.uuid() }), response: { 200: JobRecord } },
  'POST /jobs/:id/cancel': {
    params: z.object({ id: z.uuid() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'POST /internal/jobs/:id/status': {
    params: z.object({ id: z.uuid() }),
    body: ENGINE_CALLBACKS.jobStatus.body,
    response: { 200: ENGINE_CALLBACKS.jobStatus.reply },
  },
})
