import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { PolicyService } from './domain/policy-service.js'

/**
 * Политики строк и столбцов датасета (03-access-model.md, ADR-0004): список, создание,
 * правка и удаление — с уровнем manage на датасет.
 */
export function registerDatasetPolicyRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /datasets/:id/policies',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Политики строк и столбцов датасета',
    handler: async (request) => PolicyService.list(request.params.id),
  })

  route({
    route: 'POST /datasets/:id/policies/rows',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Добавить политику строк: кому и какие строки видны',
    handler: async (request) =>
      db().transaction((tx) =>
        PolicyService.createRow(tx, request.ctx, request.params.id, request.body),
      ),
  })

  route({
    route: 'PATCH /datasets/:id/policies/rows/:policyId',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Изменить политику строк',
    handler: async (request) =>
      db().transaction((tx) =>
        PolicyService.updateRow(
          tx,
          request.ctx,
          request.params.id,
          request.params.policyId,
          request.body,
        ),
      ),
  })

  route({
    route: 'DELETE /datasets/:id/policies/rows/:policyId',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Удалить политику строк',
    handler: async (request) => {
      await db().transaction((tx) =>
        PolicyService.removeRow(tx, request.ctx, request.params.id, request.params.policyId),
      )
      return { ok: true }
    },
  })

  route({
    route: 'POST /datasets/:id/policies/columns',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Добавить политику столбцов: скрыть или замаскировать поля',
    handler: async (request) =>
      db().transaction((tx) =>
        PolicyService.createColumn(tx, request.ctx, request.params.id, request.body),
      ),
  })

  route({
    route: 'PATCH /datasets/:id/policies/columns/:policyId',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Изменить политику столбцов',
    handler: async (request) =>
      db().transaction((tx) =>
        PolicyService.updateColumn(
          tx,
          request.ctx,
          request.params.id,
          request.params.policyId,
          request.body,
        ),
      ),
  })

  route({
    route: 'DELETE /datasets/:id/policies/columns/:policyId',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Удалить политику столбцов',
    handler: async (request) => {
      await db().transaction((tx) =>
        PolicyService.removeColumn(tx, request.ctx, request.params.id, request.params.policyId),
      )
      return { ok: true }
    },
  })
}
