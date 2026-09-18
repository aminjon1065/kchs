import { SecurityPolicy, SecurityPolicyPatch } from '@kchs/contracts'
import { inArray } from 'drizzle-orm'
import { SecurityPolicyService } from '~/kernel/settings/security-policy.js'
import { db } from '~/shared/db/client.js'
import { roles } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'

/**
 * Политика безопасности (17-security.md §2, 05-risks N3): обязательный второй
 * фактор по ролям, гостевые ссылки, простой сессии. Меняет администратор
 * системы; изменение попадает в аудит с состоянием до и после.
 */
export function registerSecurityRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/admin/security-policy',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Политика безопасности',
    schema: { response: { 200: SecurityPolicy } },
    handler: async () => SecurityPolicyService.current(),
  })

  route({
    method: 'PATCH',
    url: '/admin/security-policy',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Изменить политику безопасности',
    schema: { body: SecurityPolicyPatch, response: { 200: SecurityPolicy } },
    handler: async (request) => {
      const patch = { ...request.body }
      if (patch.requireMfaRoles) {
        const keys = [...new Set(patch.requireMfaRoles)]
        const found = keys.length
          ? await db().select({ key: roles.key }).from(roles).where(inArray(roles.key, keys))
          : []
        const missing = keys.filter((key) => !found.some((row) => row.key === key))
        if (missing.length > 0) {
          throw errors.validation('Неизвестные роли', [
            { path: 'requireMfaRoles', message: missing.join(', '), code: 'unknown_role' },
          ])
        }
        patch.requireMfaRoles = keys
      }
      const policy = await db().transaction((tx) =>
        SecurityPolicyService.update(tx, request.ctx, patch),
      )
      // Кэш процесса — после коммита: иначе параллельный запрос закэширует старое значение
      SecurityPolicyService.invalidate()
      return policy
    },
  })
}
