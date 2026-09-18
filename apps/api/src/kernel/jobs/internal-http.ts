import { z } from 'zod'
import { config } from '~/shared/config/index.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { JobService } from './service.js'

/**
 * Внутренние маршруты для Python-движка: он сообщает статус, прогресс и
 * результат задания (01-project-structure.md §apps/engine). Аутентификация —
 * сервисный токен, доступ только из сети развёртывания.
 */
export function registerInternalJobRoutes(route: RouteRegistrar): void {
  route({
    method: 'POST',
    url: '/internal/jobs/:id/status',
    auth: 'public',
    tags: ['internal'],
    summary: 'Движок сообщает состояние задания',
    schema: {
      params: z.object({ id: z.uuid() }),
      body: z.object({
        status: z.enum(['running', 'succeeded', 'failed']),
        progress: z.number().min(0).max(1).optional(),
        message: z.string().max(500).nullable().optional(),
        result: z.record(z.string(), z.unknown()).optional(),
        error: z.string().max(4000).optional(),
      }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      const expected = config().INTERNAL_SERVICE_TOKEN
      const provided = request.headers['x-kchs-service-token']
      if (!expected || provided !== expected)
        throw errors.unauthorized('Недействительный сервисный токен')

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
        await JobService.fail(id, new Error(body.error ?? 'задание движка не выполнено'))
      }

      return { ok: true }
    },
  })
}
