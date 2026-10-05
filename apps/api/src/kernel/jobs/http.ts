import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { JobService } from './service.js'
import { canSeeJob } from './visibility.js'

export function registerJobRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /jobs',
    auth: 'session',
    tags: ['jobs'],
    summary: 'Мои задания',
    handler: async (request) => ({
      items: await JobService.listForUser(request.ctx.userId, request.query.limit),
    }),
  })

  route({
    route: 'GET /jobs/:id',
    auth: { delegated: 'canSeeJob', resource: 'job' },
    tags: ['jobs'],
    summary: 'Состояние задания',
    handler: async (request) => {
      const job = await JobService.get(request.params.id)
      if (!job || !(await canSeeJob(request.ctx, job))) throw errors.notFound('Задание')
      return job
    },
  })

  route({
    route: 'POST /jobs/:id/cancel',
    auth: { delegated: 'canSeeJob', resource: 'job' },
    tags: ['jobs'],
    summary: 'Отменить задание',
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
