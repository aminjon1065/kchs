import { SavedView, ViewCreateInput, ViewDefinition } from '@kchs/contracts'
import { z } from 'zod'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { ViewService } from './service.js'

const IdParam = z.object({ id: z.uuid() })

export function registerViewRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/views',
    auth: 'session',
    tags: ['views'],
    summary: 'Сохранённые представления списка',
    schema: {
      querystring: z.object({
        objectType: z.string().min(1).max(64),
        spaceId: z.uuid().optional(),
      }),
      response: { 200: z.object({ items: z.array(SavedView) }) },
    },
    handler: async (request) => ({
      items: await ViewService.list(request.ctx, request.query.objectType, request.query.spaceId),
    }),
  })

  route({
    method: 'POST',
    url: '/views',
    auth: 'session',
    tags: ['views'],
    summary: 'Сохранить представление',
    schema: { body: ViewCreateInput, response: { 200: SavedView } },
    handler: async (request) =>
      db().transaction((tx) => ViewService.create(tx, request.ctx, request.body)),
  })

  route({
    method: 'GET',
    url: '/views/:id',
    auth: { action: 'view' },
    tags: ['views'],
    summary: 'Представление',
    schema: { params: IdParam, response: { 200: SavedView } },
    handler: async (request) => {
      const view = await ViewService.get(request.params.id)
      if (!view) throw errors.notFound('Представление')
      return view
    },
  })

  route({
    method: 'PATCH',
    url: '/views/:id',
    auth: { action: 'edit' },
    tags: ['views'],
    summary: 'Изменить представление',
    schema: {
      params: IdParam,
      body: z.object({
        title: z.string().min(1).max(200).optional(),
        definition: ViewDefinition.optional(),
        pinned: z.boolean().optional(),
      }),
      response: { 200: SavedView },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        ViewService.update(tx, request.ctx, request.params.id, request.body),
      )
      const view = await ViewService.get(request.params.id)
      if (!view) throw errors.notFound('Представление')
      return view
    },
  })
}
