import type { Locale } from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { users } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { getPrincipalSet, loadCapabilities } from './access/principal-set.js'
import { SecurityPolicyService } from './settings/security-policy.js'

/**
 * Собирает контекст пользователя для запроса: принципалы из кэша,
 * способности из ролей, атрибуты для атрибутных ограничений.
 */
export async function buildUserCtx(
  session: { sessionId: string; userId: string; onBehalfOf: string | null; mfaEnrolled: boolean },
  request: FastifyRequest,
): Promise<UserCtx> {
  const [user] = await db()
    .select({
      id: users.id,
      displayName: users.displayName,
      locale: users.locale,
      timezone: users.timezone,
      status: users.status,
      attributes: users.attributes,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1)

  if (!user) throw errors.unauthorized('Учётная запись не найдена')
  if (user.status !== 'active') throw errors.unauthorized('Учётная запись отключена')

  const principals = await getPrincipalSet(user.id)
  const capabilities = await loadCapabilities(principals.roleKeys)
  const policy = await SecurityPolicyService.current()

  // Режим «от имени»: только в пределах активного замещения (03-access-model.md §Делегирование)
  const header = request.headers['x-kchs-on-behalf-of']
  let onBehalfOf = session.onBehalfOf
  if (typeof header === 'string' && header.length > 0) {
    if (!principals.actingFor.some((item) => item.userId === header)) {
      throw errors.forbidden('Замещение не активно', { reason: 'delegation_inactive' })
    }
    onBehalfOf = header
  }

  return {
    kind: 'user',
    userId: user.id,
    sessionId: session.sessionId,
    displayName: user.displayName,
    locale: user.locale as Locale,
    timezone: user.timezone,
    principals,
    capabilities,
    roleKeys: principals.roleKeys,
    isSystemAdmin: principals.roleKeys.includes('system_admin'),
    isSecurityAuditor: principals.roleKeys.includes('security_auditor'),
    onBehalfOf,
    shareLink: null,
    requestId: request.id,
    ip: request.ip ?? null,
    userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
    attributes: user.attributes,
    mustChangePassword: user.mustChangePassword,
    mfaEnrollmentRequired:
      !session.mfaEnrolled && SecurityPolicyService.requiresMfa(policy, principals.roleKeys),
  }
}
