import { authorize } from '~/kernel/access/authorize.js'
import { rateLimit } from '~/shared/http/rate-limit.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { search, semanticEnabled, similar } from './index-service.js'

export function registerSearchRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /search',
    auth: 'session',
    tags: ['search'],
    summary: 'Поиск по объектам с учётом прав',
    rateLimit: rateLimit(120, '1 minute'),
    handler: async (request) =>
      search(request.ctx, {
        q: request.query.q,
        limit: request.query.limit,
        offset: request.query.offset,
        mode: request.query.mode,
        ...(request.query.types?.length ? { types: request.query.types } : {}),
        ...(request.query.spaceIds?.length ? { spaceIds: request.query.spaceIds } : {}),
        ...(request.query.statuses?.length ? { statuses: request.query.statuses } : {}),
      }),
  })

  route({
    route: 'GET /objects/:id/similar',
    auth: { delegated: 'authorize(view)', objectType: 'any' },
    tags: ['search'],
    summary: 'Похожие по смыслу объекты (только доступные смотрящему)',
    handler: async (request) => {
      // Похожие ищутся от объекта — его самого нужно иметь право видеть
      await authorize(request.ctx, 'view', request.params.id)
      return {
        items: await similar(request.ctx, request.params.id, request.query.limit),
        enabled: semanticEnabled(),
      }
    },
  })
}
