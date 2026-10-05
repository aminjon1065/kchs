import { z } from 'zod'
import { Uuid } from '../../common/primitives.js'
import { defineRoutes } from '../../http/route-contract.js'
import { ObjectType } from '../../objects/object.js'
import { SearchResponse, SimilarObjects, SimilarQuery } from '../../search/search.js'

function csv<T extends z.ZodType<unknown, string>>(item: T) {
  return z
    .string()
    .max(4000)
    .transform((value) => value.split(',').filter(Boolean))
    .pipe(z.array(item).max(50))
    .optional()
}

/**
 * Маршруты ядра «search» (ADR-0188). Регистрация — `apps/api/src/kernel/search/`: http.ts.
 */
export const kernelSearchRoutes = defineRoutes({
  'GET /search': {
    query: z.object({
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
  'GET /objects/:id/similar': {
    params: z.object({ id: Uuid }),
    query: SimilarQuery,
    response: { 200: SimilarObjects },
  },
})
