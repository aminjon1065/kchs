import type { Capability } from '@kchs/contracts'
import { and, eq, gt, inArray, isNotNull, lte, sql } from 'drizzle-orm'
import type { PrincipalSet } from '~/shared/context.js'
import { afterCommit, db, type Executor } from '~/shared/db/client.js'
import { bumpVersionStamp, cache, cacheKeys, versionStamp } from '~/shared/redis/index.js'
import {
  delegations,
  employments,
  groupMembers,
  orgClosure,
  orgUnits,
  roleCapabilities,
  roles,
  userRoles,
} from '../directory/schema.js'
import { spaceMembers } from '../spaces/schema.js'

const CACHE_TTL_SECONDS = 300

/**
 * Множество принципалов пользователя (03-access-model.md):
 * сам пользователь + группы + подразделения и все их предки + должности +
 * пространства с ролями + роли + `everyone` + активные делегирования.
 */
export async function computePrincipalSet(userId: string): Promise<PrincipalSet> {
  const database = db()

  const [groupRows, employmentRows, spaceRows, roleRows, delegationRows, headedRows, version] =
    await Promise.all([
      database
        .select({ groupId: groupMembers.groupId })
        .from(groupMembers)
        .where(eq(groupMembers.userId, userId)),
      database
        .select({
          unitId: employments.unitId,
          positionId: employments.positionId,
          isPrimary: employments.isPrimary,
        })
        .from(employments)
        .where(and(eq(employments.userId, userId), sql`${employments.endsAt} is null`)),
      database
        .select({ spaceId: spaceMembers.spaceId, role: spaceMembers.role })
        .from(spaceMembers)
        .where(eq(spaceMembers.userId, userId)),
      database
        .select({ key: roles.key })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(eq(userRoles.userId, userId)),
      database
        .select({ fromUserId: delegations.fromUserId, scope: delegations.scope })
        .from(delegations)
        .where(
          and(
            eq(delegations.toUserId, userId),
            eq(delegations.status, 'active'),
            lte(delegations.startsAt, sql`now()`),
            gt(delegations.endsAt, sql`now()`),
          ),
        ),
      // Возглавляемые подразделения: руководитель видит поручения подчинённых
      database.select({ id: orgUnits.id }).from(orgUnits).where(eq(orgUnits.headUserId, userId)),
      principalsVersion(),
    ])

  const directUnitIds = employmentRows.map((r) => r.unitId)
  // Подразделение и все его предки: сотрудник отдела входит в управление
  const ancestorRows = directUnitIds.length
    ? await database
        .select({ ancestorId: orgClosure.ancestorId })
        .from(orgClosure)
        .where(inArray(orgClosure.unitId, directUnitIds))
    : []

  const unitIds = [...new Set([...directUnitIds, ...ancestorRows.map((r) => r.ancestorId)])]

  // Территории ответственности (@my_territories, ADR-0057): у каждого своего
  // подразделения — территория его самого или ближайшего предка, где она задана
  const territoryRows = directUnitIds.length
    ? await database
        .select({
          unitId: orgClosure.unitId,
          territoryId: orgUnits.territoryId,
          depth: orgClosure.depth,
        })
        .from(orgClosure)
        .innerJoin(orgUnits, eq(orgUnits.id, orgClosure.ancestorId))
        .where(and(inArray(orgClosure.unitId, directUnitIds), isNotNull(orgUnits.territoryId)))
    : []
  const nearest = new Map<string, { territoryId: string; depth: number }>()
  for (const row of territoryRows) {
    const known = nearest.get(row.unitId)
    if (row.territoryId && (!known || row.depth < known.depth)) {
      nearest.set(row.unitId, { territoryId: row.territoryId, depth: row.depth })
    }
  }
  const territoryIds = [...new Set([...nearest.values()].map((item) => item.territoryId))]
  const positionIds = [
    ...new Set(employmentRows.map((r) => r.positionId).filter((v): v is string => Boolean(v))),
  ]
  const groupIds = groupRows.map((r) => r.groupId)
  const roleKeys = roleRows.map((r) => r.key)
  const spaceRoles: Record<string, string> = {}
  for (const row of spaceRows) spaceRoles[row.spaceId] = row.role
  const headedUnitIds = headedRows.map((row) => row.id)

  const keys = [
    `user:${userId}`,
    'everyone:*',
    ...groupIds.map((id) => `group:${id}`),
    ...unitIds.map((id) => `unit:${id}`),
    ...positionIds.map((id) => `position:${id}`),
    ...roleKeys.map((key) => `role:${key}`),
    ...spaceRows.flatMap((row) => spaceRoleKeys(row.spaceId, row.role)),
    ...delegationRows.map((row) => `acting_as:${row.fromUserId}`),
    // Руководитель подразделения: видит то, что политика типа открывает главам
    // подразделений исполнителя (поручения подчинённых, ADR-0082)
    ...headedUnitIds.map((id) => `${UNIT_HEAD_PRINCIPAL}:${id}`),
  ]

  return {
    keys: [...new Set(keys)],
    userId,
    groupIds,
    unitIds,
    primaryUnitId: employmentRows.find((r) => r.isPrimary)?.unitId ?? directUnitIds[0] ?? null,
    territoryIds,
    positionIds,
    spaceRoles,
    roleKeys,
    actingFor: delegationRows.map((row) => ({ userId: row.fromUserId, scope: row.scope })),
    headedUnitIds,
    version,
  }
}

/**
 * Принципал «глава подразделения» (`unit_head:<id>`): руководитель подразделения и
 * — через цепочку подразделений сотрудника — всех вложенных (03-access-model.md,
 * `subordinates(user)`). Политика типа добавляет такие принципалы объекту, а
 * руководитель получает свои при входе.
 */
export const UNIT_HEAD_PRINCIPAL = 'unit_head'

/**
 * Главы подразделений сотрудника: его подразделения и все их предки. Кому из
 * руководителей виден объект, если политика типа открывает его «руководителям
 * исполнителя».
 */
export async function unitHeadPrincipalsOf(
  userId: string,
  executor: Executor = db(),
): Promise<string[]> {
  const rows = await executor
    .selectDistinct({ ancestorId: orgClosure.ancestorId })
    .from(employments)
    .innerJoin(orgClosure, eq(orgClosure.unitId, employments.unitId))
    .where(and(eq(employments.userId, userId), sql`${employments.endsAt} is null`))
  return rows.map((row) => `${UNIT_HEAD_PRINCIPAL}:${row.ancestorId}`).sort()
}

/** Основное подразделение сотрудника (действующее место работы). */
export async function primaryUnitOf(
  userId: string,
  executor: Executor = db(),
): Promise<string | null> {
  const rows = await executor
    .select({ unitId: employments.unitId, isPrimary: employments.isPrimary })
    .from(employments)
    .where(and(eq(employments.userId, userId), sql`${employments.endsAt} is null`))
  return rows.find((row) => row.isPrimary)?.unitId ?? rows[0]?.unitId ?? null
}

/**
 * Принципал `space:<id>:<role>` означает «роль не ниже указанной»,
 * поэтому участник с ролью `editor` получает и ключи `viewer`, `member`.
 */
const ROLE_ORDER = ['viewer', 'member', 'editor', 'admin'] as const

export function spaceRoleKeys(spaceId: string, role: string): string[] {
  const index = ROLE_ORDER.indexOf(role as (typeof ROLE_ORDER)[number])
  if (index < 0) return [`space_role:${spaceId}:${role}`]
  return ROLE_ORDER.slice(0, index + 1).map((r) => `space_role:${spaceId}:${r}`)
}

export async function loadCapabilities(roleKeys: string[]): Promise<Set<Capability>> {
  if (roleKeys.length === 0) return new Set()
  const rows = await db()
    .select({ capability: roleCapabilities.capability })
    .from(roleCapabilities)
    .innerJoin(roles, eq(roles.id, roleCapabilities.roleId))
    .where(inArray(roles.key, roleKeys))
  return new Set(rows.map((r) => r.capability as Capability))
}

// ─── Кэш ─────────────────────────────────────────────────────────────────────

/**
 * Версия наборов принципалов — отметка в долговечном Redis, а сами наборы — в кэше
 * (ADR-0175). Отметка случайная: пропавшая заменяется новой, и ни один набор,
 * посчитанный до потери, с ней не совпадёт.
 */
export async function principalsVersion(): Promise<number> {
  return versionStamp(cacheKeys.principalVersion())
}

/**
 * Инвалидация: любое изменение членства меняет глобальную версию. Изменение в
 * транзакции передаёт её — версия меняется после фиксации (ADR-0177): до неё
 * параллельный запрос пересчитал бы набор по прежнему состоянию под новой версией
 * и держал бы его весь срок кэша.
 */
export async function bumpPrincipalsVersion(executor?: Executor): Promise<void> {
  const bump = async () => {
    await bumpVersionStamp(cacheKeys.principalVersion())
  }
  if (executor) await afterCommit(executor, bump)
  else await bump()
}

export async function getPrincipalSet(userId: string): Promise<PrincipalSet> {
  const key = cacheKeys.principalSet(userId)
  // Версия и поколение — до пересчёта: сброс во время пересчёта оставит записанный
  // набор с прежней меткой, и следующий запрос его не примет. Обе метки — в
  // долговечном Redis, набор — в кэше (ADR-0175)
  const [version, generation, cached] = await Promise.all([
    principalsVersion(),
    versionStamp(cacheKeys.principalGeneration(userId)),
    cache.get(key),
  ])
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as PrincipalSet
      // Кэш прежней версии кода — без территорий или глав подразделений: пересчитываем
      if (
        parsed.version === version &&
        (parsed.generation ?? 0) === generation &&
        Array.isArray(parsed.territoryIds) &&
        Array.isArray(parsed.headedUnitIds)
      ) {
        return parsed
      }
    } catch {
      // повреждённый кэш — пересчитываем
    }
  }
  const computed = await computePrincipalSet(userId)
  computed.version = version
  computed.generation = generation
  await cache.set(key, JSON.stringify(computed), CACHE_TTL_SECONDS)
  return computed
}

/**
 * Сброс набора одного пользователя: новое поколение и удаление записи из кэша.
 * Изменение в транзакции передаёт её — сброс идёт после фиксации (ADR-0177).
 * Недоступный кэш не страшен: набор с прежним поколением не будет принят.
 */
export async function invalidatePrincipalSet(userId: string, executor?: Executor): Promise<void> {
  const invalidate = async () => {
    await bumpVersionStamp(cacheKeys.principalGeneration(userId))
    await cache.del(cacheKeys.principalSet(userId))
  }
  if (executor) await afterCommit(executor, invalidate)
  else await invalidate()
}
