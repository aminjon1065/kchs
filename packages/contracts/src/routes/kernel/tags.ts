import { z } from 'zod'
import { defineRoutes } from '../../http/route-contract.js'
import { TAG_NAME_MAX, TagAssignInput, TagListResponse } from '../../objects/tags.js'

/**
 * Маршруты ядра «tags» (ADR-0188). Регистрация — `apps/api/src/kernel/tags/`: http.ts.
 */
export const kernelTagsRoutes = defineRoutes({
  'GET /tags': {
    query: z.object({
      spaceId: z.uuid().optional(),
      q: z.string().max(TAG_NAME_MAX).default(''),
    }),
    response: { 200: TagListResponse },
  },
  'POST /objects/:id/tags': {
    params: z.object({ id: z.uuid() }),
    body: TagAssignInput,
    response: { 200: TagListResponse },
  },
  'DELETE /objects/:id/tags/:tagId': {
    params: z.object({ id: z.uuid(), tagId: z.uuid() }),
    response: { 200: TagListResponse },
  },
})
