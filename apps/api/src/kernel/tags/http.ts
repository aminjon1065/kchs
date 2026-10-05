import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { authorize } from '../access/authorize.js'
import { TagService } from './service.js'

export function registerTagRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /tags',
    auth: 'session',
    tags: ['tags'],
    summary: 'Подсказки тегов: словарь пространства и общие теги',
    handler: async (request) => {
      // Словарь пространства виден тому, кто видит само пространство
      if (request.query.spaceId) await authorize(request.ctx, 'view', request.query.spaceId)
      return {
        items: await TagService.suggest(request.query.spaceId ?? null, request.query.q.trim()),
      }
    },
  })

  route({
    route: 'POST /objects/:id/tags',
    auth: { action: 'edit' },
    tags: ['tags'],
    summary: 'Назначить тег (создаётся в пространстве объекта при первом использовании)',
    handler: async (request) => ({
      items: await db().transaction((tx) =>
        TagService.add(tx, request.ctx, request.params.id, request.body),
      ),
    }),
  })

  route({
    route: 'DELETE /objects/:id/tags/:tagId',
    auth: { action: 'edit' },
    tags: ['tags'],
    summary: 'Снять тег с объекта',
    handler: async (request) => ({
      items: await db().transaction((tx) =>
        TagService.remove(tx, request.ctx, request.params.id, request.params.tagId),
      ),
    }),
  })
}
