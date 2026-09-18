import { TAG_NAME_MAX, TagAssignInput, TagListResponse } from '@kchs/contracts'
import { z } from 'zod'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { authorize } from '../access/authorize.js'
import { TagService } from './service.js'

export function registerTagRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/tags',
    auth: 'session',
    tags: ['tags'],
    summary: 'Подсказки тегов: словарь пространства и общие теги',
    schema: {
      querystring: z.object({
        spaceId: z.uuid().optional(),
        q: z.string().max(TAG_NAME_MAX).default(''),
      }),
      response: { 200: TagListResponse },
    },
    handler: async (request) => {
      // Словарь пространства виден тому, кто видит само пространство
      if (request.query.spaceId) await authorize(request.ctx, 'view', request.query.spaceId)
      return {
        items: await TagService.suggest(request.query.spaceId ?? null, request.query.q.trim()),
      }
    },
  })

  route({
    method: 'POST',
    url: '/objects/:id/tags',
    auth: { action: 'edit' },
    tags: ['tags'],
    summary: 'Назначить тег (создаётся в пространстве объекта при первом использовании)',
    schema: {
      params: z.object({ id: z.uuid() }),
      body: TagAssignInput,
      response: { 200: TagListResponse },
    },
    handler: async (request) => ({
      items: await db().transaction((tx) =>
        TagService.add(tx, request.ctx, request.params.id, request.body),
      ),
    }),
  })

  route({
    method: 'DELETE',
    url: '/objects/:id/tags/:tagId',
    auth: { action: 'edit' },
    tags: ['tags'],
    summary: 'Снять тег с объекта',
    schema: {
      params: z.object({ id: z.uuid(), tagId: z.uuid() }),
      response: { 200: TagListResponse },
    },
    handler: async (request) => ({
      items: await db().transaction((tx) =>
        TagService.remove(tx, request.ctx, request.params.id, request.params.tagId),
      ),
    }),
  })
}
