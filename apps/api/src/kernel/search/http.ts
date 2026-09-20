import { ObjectType, SearchResponse, SimilarObjects, SimilarQuery, Uuid } from '@kchs/contracts'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { rateLimit } from '~/shared/http/rate-limit.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { search, semanticEnabled, similar } from './index-service.js'

/** Список через запятую, каждый элемент проверяется схемой — `?types=file,folder`. */
function csv<T extends z.ZodType<unknown, string>>(item: T) {
  return z
    .string()
    .max(4000)
    .transform((value) => value.split(',').filter(Boolean))
    .pipe(z.array(item).max(50))
    .optional()
}

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
        types: csv(ObjectType),
        spaceIds: csv(Uuid),
        statuses: csv(z.string().min(1).max(40)),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).max(1000).default(0),
        /** `words` — искать только словами, без смысла (ADR-0099). */
        mode: z.enum(['hybrid', 'words']).default('hybrid'),
      }),
      response: { 200: SearchResponse },
    },
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
    method: 'GET',
    url: '/objects/:id/similar',
    auth: 'session',
    tags: ['search'],
    summary: 'Похожие по смыслу объекты (только доступные смотрящему)',
    schema: {
      params: z.object({ id: Uuid }),
      querystring: SimilarQuery,
      response: { 200: SimilarObjects },
    },
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
