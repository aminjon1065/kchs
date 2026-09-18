import { timingSafeEqual } from 'node:crypto'
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
        /** Последняя попытка: после неё движок задание не повторит. */
        final: z.boolean().default(true),
      }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      if (!validServiceToken(request.headers['x-kchs-service-token'])) {
        throw errors.unauthorized('Недействительный сервисный токен')
      }

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

/** Сравнение за постоянное время: по времени ответа токен не подобрать. */
export function validServiceToken(provided: string | string[] | undefined): boolean {
  const expected = config().INTERNAL_SERVICE_TOKEN
  if (!expected || typeof provided !== 'string') return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
