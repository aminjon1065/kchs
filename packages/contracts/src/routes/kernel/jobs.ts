import { z } from 'zod'
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
    body: z.object({
      status: z.enum(['running', 'succeeded', 'failed']),
      progress: z.number().min(0).max(1).optional(),
      message: z.string().max(500).nullable().optional(),
      result: z.record(z.string(), z.unknown()).optional(),
      error: z.string().max(4000).optional(),
      /** Последняя попытка: после неё движок задание не повторит. */
      final: z.boolean().default(true),
    }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
})
