import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { hasCapability } from '~/kernel/access/authorize.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { roles, userRoles, users } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'

/**
 * Кто может назначать роли и управлять чужими учётными записями
 * (03-access-model.md §Способности, 17-security.md).
 *
 * - `system_admin` и `security_auditor` назначает, снимает и обслуживает
 *   (сброс пароля и MFA, блокировка) только администратор системы;
 * - способность `roles.manage` даёт управление остальными ролями;
 * - `users.manage` без `roles.manage` (администратор оргструктуры) работает
 *   только с сотрудниками на базовой роли и может назначать только её.
 *
 * Так администратор оргструктуры не повышает себя до администратора системы
 * и не захватывает учётную запись администратора через сброс пароля.
 */
export const PRIVILEGED_ROLES = new Set(['system_admin', 'security_auditor'])
export const BASELINE_ROLES = new Set(['employee'])

function isSuperuser(ctx: Ctx): boolean {
  return ctx.kind === 'system' || ctx.isSystemAdmin
}

/** Роли существуют и назначить их этому пользователю можно. */
export async function assertCanAssignRoles(
  tx: Executor,
  ctx: Ctx,
  roleKeys: string[],
): Promise<void> {
  const unique = [...new Set(roleKeys)]
  const found = unique.length
    ? await tx.select({ key: roles.key }).from(roles).where(inArray(roles.key, unique))
    : []
  const missing = unique.filter((key) => !found.some((row) => row.key === key))
  if (missing.length > 0) {
    throw errors.validation('Неизвестные роли', [
      { path: 'roleKeys', message: missing.join(', '), code: 'unknown_role' },
    ])
  }
  if (isSuperuser(ctx)) return

  const privileged = unique.filter((key) => PRIVILEGED_ROLES.has(key))
  if (privileged.length > 0) {
    throw errors.forbidden('Эти роли назначает только администратор системы', {
      roles: privileged,
    })
  }
  if (hasCapability(ctx, 'roles.manage')) return

  const beyondBaseline = unique.filter((key) => !BASELINE_ROLES.has(key))
  if (beyondBaseline.length > 0) {
    throw errors.forbidden('Для назначения ролей требуется способность roles.manage', {
      roles: beyondBaseline,
    })
  }
}

/**
 * Можно ли изменять учётную запись: профиль, роли, статус, пароль, второй фактор.
 * Своими ролями и статусом через администрирование не управляют.
 */
export async function assertCanManageUser(
  tx: Executor,
  ctx: Ctx,
  userId: string,
  options: { changesRolesOrStatus?: boolean } = {},
): Promise<void> {
  if (ctx.kind === 'user' && ctx.userId === userId && options.changesRolesOrStatus) {
    throw errors.forbidden('Собственные роли и статус меняет другой администратор')
  }
  if (isSuperuser(ctx)) return

  const targetRoles = (
    await tx
      .select({ key: roles.key })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, userId))
  ).map((row) => row.key)

  if (targetRoles.some((key) => PRIVILEGED_ROLES.has(key))) {
    throw errors.forbidden('Учётной записью администратора управляет только администратор системы')
  }
  if (hasCapability(ctx, 'roles.manage')) return
  if (targetRoles.some((key) => !BASELINE_ROLES.has(key))) {
    throw errors.forbidden('Сотрудником с расширенными ролями управляет владелец roles.manage')
  }
}

/** В системе должен остаться хотя бы один активный администратор системы. */
export async function assertNotLastSystemAdmin(tx: Executor, userId: string): Promise<void> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(
      and(eq(roles.key, 'system_admin'), eq(users.status, 'active'), ne(userRoles.userId, userId)),
    )
  if ((row?.count ?? 0) === 0) {
    throw errors.conflict('Нельзя отключить последнего администратора системы')
  }
}

export async function hasRole(tx: Executor, userId: string, key: string): Promise<boolean> {
  const rows = await tx
    .select({ key: roles.key })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(userRoles.userId, userId), eq(roles.key, key)))
    .limit(1)
  return rows.length > 0
}
