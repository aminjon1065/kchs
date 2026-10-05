import { PasskeyInfo } from '@kchs/contracts'
import { z } from 'zod'
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
    method: 'POST',
    url: '/users/:id/reset-mfa',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Сбросить второй фактор пользователя',
    schema: {
      params: z.object({ id: z.uuid() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await assertCanManageUser(db(), request.ctx, request.params.id)
      await AuthService.disableMfa(request.ctx, request.params.id)
      return { ok: true }
    },
  })

  route({
    method: 'GET',
    url: '/users/:id/passkeys',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Ключи входа сотрудника — перед отзывом (N45)',
    schema: {
      params: z.object({ id: z.uuid() }),
      response: { 200: z.object({ items: z.array(PasskeyInfo) }) },
    },
    handler: async (request) => {
      await assertCanManageUser(db(), request.ctx, request.params.id)
      return { items: await PasskeyService.list(request.params.id) }
    },
  })

  route({
    method: 'DELETE',
    url: '/users/:id/passkeys',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Отозвать все ключи входа сотрудника (N45)',
    schema: {
      params: z.object({ id: z.uuid() }),
      response: { 200: z.object({ revoked: z.number().int() }) },
    },
    handler: async (request) => {
      await assertCanManageUser(db(), request.ctx, request.params.id)
      return { revoked: await PasskeyService.revokeAll(request.ctx, request.params.id) }
    },
  })
}
