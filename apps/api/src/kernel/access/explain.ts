import { type Locale, parseConfidentiality } from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { users } from '~/shared/db/schema/index.js'
import { getPrincipalSet, loadCapabilities } from './principal-set.js'

/**
 * Контекст произвольного пользователя — нужен для «Проверить доступ пользователя»
 * и для негативных тестов доступа.
 */
export async function buildUserCtxFor(userId: string): Promise<UserCtx | null> {
  const [user] = await db()
    .select({
      id: users.id,
      displayName: users.displayName,
      locale: users.locale,
      timezone: users.timezone,
      attributes: users.attributes,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!user) return null

  const principals = await getPrincipalSet(user.id)
  const capabilities = await loadCapabilities(principals.roleKeys)

  return {
    kind: 'user',
    userId: user.id,
    sessionId: 'explain',
    displayName: user.displayName,
    locale: user.locale as Locale,
    timezone: user.timezone,
    principals,
    capabilities,
    roleKeys: principals.roleKeys,
    isSystemAdmin: principals.roleKeys.includes('system_admin'),
    isSecurityAuditor: principals.roleKeys.includes('security_auditor'),
    onBehalfOf: null,
    shareLink: null,
    requestId: 'explain',
    ip: null,
    userAgent: null,
    attributes: user.attributes,
    clearance: parseConfidentiality(user.attributes.clearance),
    adminMode: null,
    mustChangePassword: false,
    mfaEnrollmentRequired: false,
  }
}

/**
 * Пользователи из списка, которые видят объект: уведомление об упоминании не
 * должно раскрывать название объекта тому, у кого к нему нет доступа.
 */
export async function usersWhoCanView(objectId: string, userIds: string[]): Promise<string[]> {
  const { authorize } = await import('./authorize.js')
  const result: string[] = []
  for (const userId of [...new Set(userIds)]) {
    const ctx = await buildUserCtxFor(userId)
    if (!ctx) continue
    const decision = await authorize(ctx, 'view', objectId, { soft: true })
    if (decision.allowed) result.push(userId)
  }
  return result
}
