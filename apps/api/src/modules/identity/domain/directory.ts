import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { type Database, db } from '~/shared/db/client.js'
import {
  employments,
  groupMembers,
  orgClosure,
  orgUnits,
  roles,
  userRoles,
  users,
} from '~/shared/db/schema/index.js'

/**
 * Запросы справочника для назначений по оргструктуре (порт ядра
 * `DirectoryProvider`, ADR-0079): только активные сотрудники и действующие
 * занятости; порядок — по имени, чтобы очередь назначенных была стабильной.
 */
export const DirectoryQueries = {
  /** Основное подразделение, иначе — первое действующее (как во множестве принципалов). */
  async primaryUnit(userId: string, database: Database = db()): Promise<string | null> {
    const rows = await database
      .select({ unitId: employments.unitId, isPrimary: employments.isPrimary })
      .from(employments)
      .where(and(eq(employments.userId, userId), isNull(employments.endsAt)))
      .orderBy(sql`${employments.isPrimary} desc`, asc(employments.createdAt))
      .limit(1)
    return rows[0]?.unitId ?? null
  },

  /** Сотрудники подразделения и всех вложенных подразделений. */
  async unitMembers(unitId: string, database: Database = db()): Promise<string[]> {
    const rows = await database
      .selectDistinct({ id: users.id, name: users.displayName })
      .from(orgClosure)
      .innerJoin(employments, eq(employments.unitId, orgClosure.unitId))
      .innerJoin(users, eq(users.id, employments.userId))
      .where(
        and(
          eq(orgClosure.ancestorId, unitId),
          isNull(employments.endsAt),
          eq(users.status, 'active'),
        ),
      )
      .orderBy(asc(users.displayName), asc(users.id))
    return rows.map((row) => row.id)
  },

  async unitByCode(code: string, database: Database = db()): Promise<string | null> {
    const [row] = await database
      .select({ id: orgUnits.id })
      .from(orgUnits)
      .where(eq(orgUnits.code, code))
      .limit(1)
    return row?.id ?? null
  },

  async groupMembers(groupId: string, database: Database = db()): Promise<string[]> {
    const rows = await database
      .select({ id: users.id })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(eq(groupMembers.groupId, groupId), eq(users.status, 'active')))
      .orderBy(asc(users.displayName), asc(users.id))
    return rows.map((row) => row.id)
  },

  /**
   * Обладатели роли: `effective` — без ограничения и ограниченные
   * пространством `spaceId`; `space` — только ограниченные им.
   */
  async usersWithRole(
    roleKey: string,
    options: { spaceId: string | null; scope: 'effective' | 'space' },
    database: Database = db(),
  ): Promise<string[]> {
    if (options.scope === 'space' && !options.spaceId) return []
    const scope =
      options.scope === 'space'
        ? eq(userRoles.spaceId, options.spaceId as string)
        : options.spaceId
          ? or(isNull(userRoles.spaceId), eq(userRoles.spaceId, options.spaceId))
          : isNull(userRoles.spaceId)
    const rows = await database
      .select({ id: users.id })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(and(eq(roles.key, roleKey), eq(users.status, 'active'), scope))
      .orderBy(asc(users.displayName), asc(users.id))
    return rows.map((row) => row.id)
  },

  async activeUsers(userIds: string[], database: Database = db()): Promise<string[]> {
    if (userIds.length === 0) return []
    const rows = await database
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, userIds), eq(users.status, 'active')))
    const active = new Set(rows.map((row) => row.id))
    return userIds.filter((id) => active.has(id))
  },
}
