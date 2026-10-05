import { JobRecord } from '@kchs/contracts'
import { z } from 'zod'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { JobService } from './service.js'
import { canSeeJob } from './visibility.js'

export function registerJobRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/jobs',
    auth: 'session',
    tags: ['jobs'],
    summary: 'Мои задания',
    schema: {
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
      response: { 200: z.object({ items: z.array(JobRecord) }) },
    },
    handler: async (request) => ({
      items: await JobService.listForUser(request.ctx.userId, request.query.limit),
    }),
  })

  route({
    method: 'GET',
    url: '/jobs/:id',
    auth: 'session',
    tags: ['jobs'],
    summary: 'Состояние задания',
    schema: { params: z.object({ id: z.uuid() }), response: { 200: JobRecord } },
    handler: async (request) => {
      const job = await JobService.get(request.params.id)
      if (!job || !(await canSeeJob(request.ctx, job))) throw errors.notFound('Задание')
      return job
    },
  })

  route({
    method: 'POST',
    url: '/jobs/:id/cancel',
    auth: 'session',
    tags: ['jobs'],
    summary: 'Отменить задание',
    schema: {
      params: z.object({ id: z.uuid() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      const job = await JobService.get(request.params.id)
      if (!job || !(await canSeeJob(request.ctx, job))) throw errors.notFound('Задание')
      if (job.initiatorId !== request.ctx.userId && !request.ctx.isSystemAdmin) {
        throw errors.forbidden('Задание может отменить только инициатор')
      }
      const outcome = await JobService.cancel(request.ctx, request.params.id)
      if (outcome === 'missing') throw errors.notFound('Задание')
      if (outcome === 'closed') throw errors.conflict('Задание уже завершено')
      return { ok: true }
    },
  })
}
