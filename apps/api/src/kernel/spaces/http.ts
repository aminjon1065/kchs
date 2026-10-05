import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { authorize } from '../access/authorize.js'
import { AUDIT_ACTIONS, audit } from '../audit/service.js'
import { ObjectService } from '../objects/service.js'
import { SpaceService } from './service.js'

export function registerSpaceRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /spaces',
    auth: 'session',
    tags: ['spaces'],
    summary: 'Пространства пользователя',
    handler: async (request) => ({ items: await SpaceService.listForUser(request.ctx) }),
  })

  route({
    route: 'POST /spaces',
    auth: { capability: 'spaces.create' },
    tags: ['spaces'],
    summary: 'Создать пространство',
    handler: async (request) => {
      const id = await db().transaction((tx) => SpaceService.create(tx, request.ctx, request.body))
      return { id }
    },
  })

  route({
    route: 'GET /spaces/:id',
    auth: { action: 'view' },
    tags: ['spaces'],
    summary: 'Пространство',
    handler: async (request) => {
      const space = await SpaceService.get(request.params.id, request.ctx)
      if (!space) throw errors.notFound('Пространство')
      return space
    },
  })

  route({
    route: 'GET /spaces/:id/members',
    auth: { action: 'view' },
    tags: ['spaces'],
    summary: 'Участники пространства',
    handler: async (request) => ({ items: await SpaceService.members(request.params.id) }),
  })

  route({
    route: 'POST /spaces/:id/members',
    auth: { action: 'invite' },
    tags: ['spaces'],
    summary: 'Добавить участника',
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
    route: 'PUT /spaces/:id/members/:userId',
    auth: { action: 'invite' },
    tags: ['spaces'],
    summary: 'Изменить роль участника',
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
    route: 'DELETE /spaces/:id/members/:userId',
    auth: { action: 'invite' },
    tags: ['spaces'],
    summary: 'Исключить участника',
    handler: async (request) => {
      await authorize(request.ctx, 'invite', request.params.id)
      await db().transaction((tx) =>
        SpaceService.removeMember(tx, request.ctx, request.params.id, request.params.userId),
      )
      return { ok: true }
    },
  })

  // ─── Консоль администрирования (15-admin-operations.md «Пространства») ─────
  route({
    route: 'GET /admin/spaces',
    auth: { capability: 'admin.system' },
    tags: ['spaces'],
    summary: 'Все пространства организации: состав и администраторы',
    handler: async (request) => ({ items: await SpaceService.adminList(request.query) }),
  })

  route({
    route: 'POST /admin/spaces/:id/admins',
    auth: { capability: 'admin.system' },
    tags: ['spaces'],
    summary: 'Назначить администратора пространства (передача, если прежний ушёл)',
    handler: async (request) => {
      await db().transaction(async (tx) => {
        await SpaceService.addMember(
          tx,
          request.ctx,
          request.params.id,
          request.body.userId,
          'admin',
        )
        // Вмешательство администратора системы в чужое пространство — в аудит
        await audit(
          request.ctx,
          {
            action: AUDIT_ACTIONS.spaceAdminAssigned,
            objectId: request.params.id,
            objectType: 'space',
            details: { userId: request.body.userId },
          },
          tx,
        )
      })
      return { ok: true }
    },
  })

  route({
    route: 'PATCH /spaces/:id',
    auth: { action: 'manage' },
    tags: ['spaces'],
    summary: 'Переименовать пространство, изменить описание',
    handler: async (request) => {
      await db().transaction((tx) =>
        SpaceService.update(tx, request.ctx, request.params.id, request.body),
      )
      return { ok: true }
    },
  })

  // Архив, возврат и удаление — пространство вместе с содержимым (ADR-0152)
  route({
    route: 'POST /spaces/:id/archive',
    auth: { action: 'archive' },
    tags: ['spaces'],
    summary: 'Отправить пространство в архив вместе с содержимым',
    handler: async (request) => {
      await db().transaction(async (tx) => {
        await ObjectService.archive(tx, request.ctx, request.params.id)
        await audit(
          request.ctx,
          { action: AUDIT_ACTIONS.spaceArchived, objectId: request.params.id, objectType: 'space' },
          tx,
        )
      })
      return { ok: true }
    },
  })

  route({
    route: 'POST /spaces/:id/unarchive',
    auth: { action: 'archive' },
    tags: ['spaces'],
    summary: 'Вернуть пространство из архива',
    handler: async (request) => {
      await db().transaction(async (tx) => {
        await ObjectService.restore(tx, request.ctx, request.params.id)
        await audit(
          request.ctx,
          {
            action: AUDIT_ACTIONS.spaceUnarchived,
            objectId: request.params.id,
            objectType: 'space',
          },
          tx,
        )
      })
      return { ok: true }
    },
  })

  route({
    route: 'DELETE /spaces/:id',
    auth: { action: 'delete' },
    tags: ['spaces'],
    summary: 'Удалить заархивированное или пустое пространство (в корзину на 30 дней)',
    handler: async (request) => {
      await db().transaction(async (tx) => {
        await ObjectService.trash(tx, request.ctx, request.params.id)
        await audit(
          request.ctx,
          {
            action: AUDIT_ACTIONS.spaceDeleted,
            objectId: request.params.id,
            objectType: 'space',
            severity: 'warning',
          },
          tx,
        )
      })
      return { ok: true }
    },
  })
}
