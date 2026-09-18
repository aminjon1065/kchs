import {
  NamedWorkspace,
  NamedWorkspaceInput,
  NamedWorkspacePatch,
  NamedWorkspaceSummary,
  SavedView,
  ViewCreateInput,
  ViewDefinition,
} from '@kchs/contracts'
import { z } from 'zod'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { ViewService } from './service.js'
import { WorkspaceViews } from './workspaces.js'

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

  // ─── Именованные рабочие пространства ─────────────────────────────────────
  route({
    method: 'GET',
    url: '/workspaces',
    auth: 'session',
    tags: ['views'],
    summary: 'Именованные рабочие пространства: свои и общие',
    schema: { response: { 200: z.object({ items: z.array(NamedWorkspaceSummary) }) } },
    handler: async (request) => ({ items: await WorkspaceViews.list(request.ctx) }),
  })

  route({
    method: 'POST',
    url: '/workspaces',
    auth: 'session',
    tags: ['views'],
    summary: 'Сохранить набор вкладок как рабочее пространство',
    schema: { body: NamedWorkspaceInput, response: { 200: NamedWorkspace } },
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
    method: 'GET',
    url: '/workspaces/:id',
    auth: { action: 'view' },
    tags: ['views'],
    summary: 'Рабочее пространство с раскладкой вкладок',
    schema: { params: IdParam, response: { 200: NamedWorkspace } },
    handler: async (request) => {
      const workspace = await WorkspaceViews.get(request.params.id)
      if (!workspace) throw errors.notFound('Рабочее пространство')
      return workspace
    },
  })

  route({
    method: 'PATCH',
    url: '/workspaces/:id',
    auth: { action: 'edit' },
    tags: ['views'],
    summary: 'Переименовать, закрепить или перезаписать раскладку',
    schema: { params: IdParam, body: NamedWorkspacePatch, response: { 200: NamedWorkspace } },
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
