import { type SearchQuery, SearchResponse } from '@kchs/contracts'
import { z } from 'zod'
import { rateLimit } from '~/shared/http/rate-limit.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { search } from './index-service.js'

export function registerSearchRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/search',
    auth: 'session',
    tags: ['search'],
    summary: 'Поиск по объектам с учётом прав',
    rateLimit: rateLimit(120, '1 minute'),
    schema: {
      querystring: z.object({
        q: z.string().max(500).default(''),
        types: z.string().optional(),
        spaceIds: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).max(1000).default(0),
      }),
      response: { 200: SearchResponse },
    },
    handler: async (request) => {
      const query: SearchQuery = {
        q: request.query.q,
        limit: request.query.limit,
        offset: request.query.offset,
        ...(request.query.types
          ? { types: request.query.types.split(',').filter(Boolean) as SearchQuery['types'] }
          : {}),
        ...(request.query.spaceIds
          ? { spaceIds: request.query.spaceIds.split(',').filter(Boolean) }
          : {}),
      }
      return search(request.ctx, query)
    },
  })
}
