import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { ViewService } from './service.js'
import { WorkspaceViews } from './workspaces.js'

export function registerViewRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /views',
    auth: 'session',
    tags: ['views'],
    summary: 'Сохранённые представления списка',
    handler: async (request) => ({
      items: await ViewService.list(request.ctx, request.query.objectType, request.query.spaceId),
    }),
  })

  route({
    route: 'POST /views',
    auth: 'session',
    tags: ['views'],
    summary: 'Сохранить представление',
    handler: async (request) =>
      db().transaction((tx) => ViewService.create(tx, request.ctx, request.body)),
  })

  route({
    route: 'GET /views/:id',
    auth: { action: 'view' },
    tags: ['views'],
    summary: 'Представление',
    handler: async (request) => {
      const view = await ViewService.get(request.params.id)
      if (!view) throw errors.notFound('Представление')
      return view
    },
  })

  route({
    route: 'PATCH /views/:id',
    auth: { action: 'edit' },
    tags: ['views'],
    summary: 'Изменить представление',
    handler: async (request) => {
      await db().transaction((tx) =>
        ViewService.update(tx, request.ctx, request.params.id, request.body),
      )
      const view = await ViewService.get(request.params.id)
      if (!view) throw errors.notFound('Представление')
      return view
    },
  })

  // ─── Именованные рабочие пространства ─────────────────────────────────────
  route({
    route: 'GET /workspaces',
    auth: 'session',
    tags: ['views'],
    summary: 'Именованные рабочие пространства: свои и общие',
    handler: async (request) => ({ items: await WorkspaceViews.list(request.ctx) }),
  })

  route({
    route: 'POST /workspaces',
    auth: 'session',
    tags: ['views'],
    summary: 'Сохранить набор вкладок как рабочее пространство',
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        WorkspaceViews.create(tx, request.ctx, request.body),
      )
      const workspace = await WorkspaceViews.get(id)
      if (!workspace) throw errors.internal('Рабочее пространство не сохранилось')
      return workspace
    },
  })

  route({
    route: 'GET /workspaces/:id',
    auth: { action: 'view' },
    tags: ['views'],
    summary: 'Рабочее пространство с раскладкой вкладок',
    handler: async (request) => {
      const workspace = await WorkspaceViews.get(request.params.id)
      if (!workspace) throw errors.notFound('Рабочее пространство')
      return workspace
    },
  })

  route({
    route: 'PATCH /workspaces/:id',
    auth: { action: 'edit' },
    tags: ['views'],
    summary: 'Переименовать, закрепить или перезаписать раскладку',
    handler: async (request) => {
      if (!(await WorkspaceViews.get(request.params.id))) {
        throw errors.notFound('Рабочее пространство')
      }
      await db().transaction((tx) =>
        WorkspaceViews.update(tx, request.ctx, request.params.id, request.body),
      )
      const workspace = await WorkspaceViews.get(request.params.id)
      if (!workspace) throw errors.notFound('Рабочее пространство')
      return workspace
    },
  })
}
