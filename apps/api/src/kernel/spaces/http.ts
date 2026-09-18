import { Space, SpaceCreateInput, SpaceMember, SpaceRole } from '@kchs/contracts'
import { z } from 'zod'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { authorize } from '../access/authorize.js'
import { SpaceService } from './service.js'

const IdParam = z.object({ id: z.uuid() })

export function registerSpaceRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/spaces',
    auth: 'session',
    tags: ['spaces'],
    summary: 'Пространства пользователя',
    schema: { response: { 200: z.object({ items: z.array(Space) }) } },
    handler: async (request) => ({ items: await SpaceService.listForUser(request.ctx) }),
  })

  route({
    method: 'POST',
    url: '/spaces',
    auth: { capability: 'spaces.create' },
    tags: ['spaces'],
    summary: 'Создать пространство',
    schema: { body: SpaceCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => {
      const id = await db().transaction((tx) => SpaceService.create(tx, request.ctx, request.body))
      return { id }
    },
  })

  route({
    method: 'GET',
    url: '/spaces/:id',
    auth: { action: 'view' },
    tags: ['spaces'],
    summary: 'Пространство',
    schema: { params: IdParam, response: { 200: Space } },
    handler: async (request) => {
      const space = await SpaceService.get(request.params.id, request.ctx)
      if (!space) throw errors.notFound('Пространство')
      return space
    },
  })

  route({
    method: 'GET',
    url: '/spaces/:id/members',
    auth: { action: 'view' },
    tags: ['spaces'],
    summary: 'Участники пространства',
    schema: { params: IdParam, response: { 200: z.object({ items: z.array(SpaceMember) }) } },
    handler: async (request) => ({ items: await SpaceService.members(request.params.id) }),
  })

  route({
    method: 'POST',
    url: '/spaces/:id/members',
    auth: { action: 'invite' },
    tags: ['spaces'],
    summary: 'Добавить участника',
    schema: {
      params: IdParam,
      body: z.object({ userId: z.uuid(), role: SpaceRole }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        SpaceService.addMember(
          tx,
          request.ctx,
          request.params.id,
          request.body.userId,
          request.body.role,
        ),
      )
      return { ok: true }
    },
  })

  route({
    method: 'PUT',
    url: '/spaces/:id/members/:userId',
    auth: { action: 'invite' },
    tags: ['spaces'],
    summary: 'Изменить роль участника',
    schema: {
      params: z.object({ id: z.uuid(), userId: z.uuid() }),
      body: z.object({ role: SpaceRole }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        SpaceService.setMemberRole(
          tx,
          request.ctx,
          request.params.id,
          request.params.userId,
          request.body.role,
        ),
      )
      return { ok: true }
    },
  })

  route({
    method: 'DELETE',
    url: '/spaces/:id/members/:userId',
    auth: { action: 'invite' },
    tags: ['spaces'],
    summary: 'Исключить участника',
    schema: {
      params: z.object({ id: z.uuid(), userId: z.uuid() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await authorize(request.ctx, 'invite', request.params.id)
      await db().transaction((tx) =>
        SpaceService.removeMember(tx, request.ctx, request.params.id, request.params.userId),
      )
      return { ok: true }
    },
  })
}
