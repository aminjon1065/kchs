import { assertCanManageUser } from '~/kernel/directory/role-policy.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { AuthService } from '../domain/auth-service.js'
import { PasskeyService } from '../domain/passkeys.js'

/**
 * Учётные данные сотрудника в консоли оргструктуры (ADR-0179): сброс второго
 * фактора и ключи входа — операции модуля входа; сотрудника и права на его
 * управление ведёт справочник ядра.
 */
export function registerUserCredentialRoutes(route: RouteRegistrar): void {
  route({
    route: 'POST /users/:id/reset-mfa',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Сбросить второй фактор пользователя',
    handler: async (request) => {
      await assertCanManageUser(db(), request.ctx, request.params.id)
      await AuthService.disableMfa(request.ctx, request.params.id)
      return { ok: true }
    },
  })

  route({
    route: 'GET /users/:id/passkeys',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Ключи входа сотрудника — перед отзывом (N45)',
    handler: async (request) => {
      await assertCanManageUser(db(), request.ctx, request.params.id)
      return { items: await PasskeyService.list(request.params.id) }
    },
  })

  route({
    route: 'DELETE /users/:id/passkeys',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Отозвать все ключи входа сотрудника (N45)',
    handler: async (request) => {
      await assertCanManageUser(db(), request.ctx, request.params.id)
      return { revoked: await PasskeyService.revokeAll(request.ctx, request.params.id) }
    },
  })
}
