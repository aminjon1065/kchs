import { JobStatusReport } from '@kchs/contracts'
import { z } from 'zod'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { JobService } from './service.js'

/**
 * Внутренние маршруты для Python-движка: он сообщает статус, прогресс и
 * результат задания (01-project-structure.md §apps/engine). Аутентификация —
 * токен этого задания (ADR-0176), доступ только из сети развёртывания.
 */
export function registerInternalJobRoutes(route: RouteRegistrar): void {
  route({
    method: 'POST',
    url: '/internal/jobs/:id/status',
    auth: { engineJob: { jobParam: 'id' } },
    tags: ['internal'],
    summary: 'Движок сообщает состояние задания',
    schema: {
      params: z.object({ id: z.uuid() }),
      body: JobStatusReport,
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      const { id } = request.params
      const body = request.body

      if (body.status === 'running') {
        if (body.progress !== undefined) {
          await JobService.progress(id, body.progress, body.message ?? undefined)
        } else {
          await JobService.start(id)
        }
      } else if (body.status === 'succeeded') {
        await JobService.finish(id, body.result ?? {})
      } else {
        await JobService.fail(id, new Error(body.error ?? 'задание движка не выполнено'), {
          final: body.final,
        })
      }

      return { ok: true }
    },
  })
}
