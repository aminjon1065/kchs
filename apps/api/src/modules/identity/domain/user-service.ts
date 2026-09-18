import type {
  AdminUser,
  AdminUserCreateInput,
  AdminUserPatchInput,
  Employment,
  Locale,
  OrgUnit,
  OrgUnitInput,
  UserProfile,
  UserRef,
  UserStatus,
} from '@kchs/contracts'
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { bumpPrincipalsVersion, invalidatePrincipalSet } from '~/kernel/access/principal-set.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { SpaceService } from '~/kernel/spaces/service.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { actorId } from '~/shared/context.js'
import { type Database, db, type Executor } from '~/shared/db/client.js'
import {
  delegations,
  employments,
  groupMembers,
  groups,
  mfaFactors,
  orgClosure,
  orgUnits,
  positions,
  roles,
  userRoles,
  users,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId, randomCode } from '~/shared/ids.js'
import { AuthService } from './auth-service.js'
import {
  assertCanAssignRoles,
  assertCanManageUser,
  assertNotLastSystemAdmin,
  hasRole,
} from './role-policy.js'

/**
 * Временный пароль `XXXX-XXXX-XXXX` (60 бит). Политика запрещает пароль,
 * содержащий логин: для коротких логинов случайный пароль изредка его
 * содержит — такой вариант перевыпускается, иначе создание падало бы наугад.
 */
export function temporaryPasswordFor(login: string): string {
  const needle = login.toLowerCase()
  for (;;) {
    const candidate = `${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`
    if (!candidate.toLowerCase().includes(needle)) return candidate
  }
}

export const UserService = {
  async create(
    tx: Executor,
    ctx: Ctx,
    input: AdminUserCreateInput,
  ): Promise<{ id: string; temporaryPassword: string | null }> {
    await assertCanAssignRoles(tx, ctx, input.roleKeys)

    const exists = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.login}) = ${input.login.toLowerCase()}`)
      .limit(1)
    if (exists.length > 0) throw errors.conflict('Логин уже занят')

    const id = newId()
    const displayName = [input.lastName, input.firstName, input.middleName]
      .filter(Boolean)
      .join(' ')

    await tx.insert(users).values({
      id,
      login: input.login,
      email: input.email ?? null,
      phone: input.phone ?? null,
      displayName,
      firstName: input.firstName,
      lastName: input.lastName,
      middleName: input.middleName ?? null,
      locale: input.locale,
      timezone: input.timezone,
      status: 'active',
      mustChangePassword: input.mustChangePassword,
    })

    const temporaryPassword = input.password ?? temporaryPasswordFor(input.login)
    await AuthService.setPassword(id, temporaryPassword, input.login, tx)
    if (input.mustChangePassword) {
      await tx.update(users).set({ mustChangePassword: true }).where(eq(users.id, id))
    }

    if (input.unitId) {
      await tx.insert(employments).values({
        id: newId(),
        userId: id,
        unitId: input.unitId,
        positionId: input.positionId ?? null,
        isPrimary: true,
      })
    }

    const roleRows = await tx.select().from(roles).where(inArray(roles.key, input.roleKeys))
    if (roleRows.length > 0) {
      await tx
        .insert(userRoles)
        .values(roleRows.map((role) => ({ userId: id, roleId: role.id, grantedBy: actorId(ctx) })))
        .onConflictDoNothing()
    }

    await SpaceService.ensurePersonal(tx, ctx, id, displayName)

    await publishEvent(tx, ctx, {
      type: 'user.created',
      object: { id, type: 'user', title: displayName },
      payload: { login: input.login },
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.userCreated,
        objectId: id,
        objectType: 'user',
        details: { login: input.login },
        severity: 'notice',
      },
      tx,
    )

    return { id, temporaryPassword: input.password ? null : temporaryPassword }
  },

  async patch(tx: Executor, ctx: Ctx, userId: string, patch: AdminUserPatchInput): Promise<void> {
    const [current] = await tx.select().from(users).where(eq(users.id, userId)).limit(1)
    if (!current) throw errors.notFound('Пользователь')

    await assertCanManageUser(tx, ctx, userId, {
      changesRolesOrStatus: patch.roleKeys !== undefined || patch.status !== undefined,
    })
    if (patch.roleKeys) await assertCanAssignRoles(tx, ctx, patch.roleKeys)
    const losesAdmin =
      (patch.roleKeys !== undefined && !patch.roleKeys.includes('system_admin')) ||
      (patch.status !== undefined && patch.status !== 'active')
    if (losesAdmin && (await hasRole(tx, userId, 'system_admin'))) {
      await assertNotLastSystemAdmin(tx, userId)
    }

    const values: Record<string, unknown> = {}
    if (patch.email !== undefined) values.email = patch.email
    if (patch.phone !== undefined) values.phone = patch.phone
    if (patch.firstName !== undefined) values.firstName = patch.firstName
    if (patch.lastName !== undefined) values.lastName = patch.lastName
    if (patch.middleName !== undefined) values.middleName = patch.middleName
    if (patch.status !== undefined) values.status = patch.status

    if (
      patch.firstName !== undefined ||
      patch.lastName !== undefined ||
      patch.middleName !== undefined
    ) {
      values.displayName = [
        patch.lastName ?? current.lastName,
        patch.firstName ?? current.firstName,
        patch.middleName ?? current.middleName,
      ]
        .filter(Boolean)
        .join(' ')
    }

    if (Object.keys(values).length > 0) {
      await tx
        .update(users)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(users.id, userId))
    }

    if (patch.roleKeys) {
      const roleRows = await tx.select().from(roles).where(inArray(roles.key, patch.roleKeys))
      await tx.delete(userRoles).where(eq(userRoles.userId, userId))
      if (roleRows.length > 0) {
        await tx
          .insert(userRoles)
          .values(roleRows.map((role) => ({ userId, roleId: role.id, grantedBy: actorId(ctx) })))
      }
      await audit(
        ctx,
        {
          action: AUDIT_ACTIONS.roleAssigned,
          objectId: userId,
          objectType: 'user',
          details: { roles: patch.roleKeys },
          severity: 'warning',
        },
        tx,
      )
      // Кэш принципалов сбрасывает подписчик ядра: роль действует сразу, а не через TTL
      await publishEvent(tx, ctx, {
        type: 'user.roles_changed',
        object: { id: userId, type: 'user', title: current.displayName },
        payload: { userId, roles: patch.roleKeys },
      })
    }

    if (patch.unitId !== undefined) {
      await tx.update(employments).set({ isPrimary: false }).where(eq(employments.userId, userId))
      if (patch.unitId) {
        await tx
          .insert(employments)
          .values({
            id: newId(),
            userId,
            unitId: patch.unitId,
            positionId: patch.positionId ?? null,
            isPrimary: true,
          })
          .onConflictDoNothing()
      }
      await publishEvent(tx, ctx, {
        type: 'org.employment_changed',
        object: { id: userId, type: 'user' },
        payload: { userId, unitId: patch.unitId },
      })
    }

    if (patch.status === 'blocked') {
      await AuthService.revokeAllExcept(userId, null)
      await publishEvent(tx, ctx, {
        type: 'user.blocked',
        object: { id: userId, type: 'user' },
        payload: { reason: null },
      })
      await audit(
        ctx,
        {
          action: AUDIT_ACTIONS.userBlocked,
          objectId: userId,
          objectType: 'user',
          severity: 'warning',
        },
        tx,
      )
    }

    await publishEvent(tx, ctx, {
      type: 'user.updated',
      object: { id: userId, type: 'user', title: current.displayName },
      changedFields: Object.keys(values),
    })
    await invalidatePrincipalSet(userId)
  },

  async profile(userId: string, database: Database = db()): Promise<UserProfile | null> {
    const [row] = await database.select().from(users).where(eq(users.id, userId)).limit(1)
    if (!row) return null
    return {
      id: row.id,
      login: row.login,
      email: row.email,
      phone: row.phone,
      displayName: row.displayName,
      firstName: row.firstName,
      lastName: row.lastName,
      middleName: row.middleName,
      avatarUrl: row.avatarFileId ? `/api/v1/files/${row.avatarFileId}/content` : null,
      locale: row.locale as Locale,
      timezone: row.timezone,
      status: row.status as UserStatus,
      attributes: row.attributes,
    }
  },

  async refs(userIds: string[], database: Database = db()): Promise<Map<string, UserRef>> {
    if (userIds.length === 0) return new Map()
    const rows = await database
      .select({
        id: users.id,
        displayName: users.displayName,
        avatarFileId: users.avatarFileId,
        status: users.status,
        positionName: positions.name,
        unitName: orgUnits.name,
      })
      .from(users)
      .leftJoin(employments, and(eq(employments.userId, users.id), eq(employments.isPrimary, true)))
      .leftJoin(positions, eq(positions.id, employments.positionId))
      .leftJoin(orgUnits, eq(orgUnits.id, employments.unitId))
      .where(inArray(users.id, userIds))

    const map = new Map<string, UserRef>()
    for (const row of rows) {
      if (map.has(row.id)) continue
      map.set(row.id, {
        id: row.id,
        displayName: row.displayName,
        avatarUrl: row.avatarFileId ? `/api/v1/files/${row.avatarFileId}/content` : null,
        position: row.positionName?.ru ?? null,
        unitName: row.unitName?.ru ?? null,
        status: row.status as UserStatus,
      })
    }
    return map
  },

  async list(query: {
    q?: string
    status?: UserStatus
    unitId?: string
    limit?: number
    cursor?: string
  }): Promise<{ items: AdminUser[]; nextCursor: string | null }> {
    const limit = Math.min(query.limit ?? 50, 200)
    const conditions = []
    if (query.q) {
      conditions.push(
        or(
          sql`${users.displayName} ilike ${`%${query.q}%`}`,
          sql`${users.login} ilike ${`%${query.q}%`}`,
          sql`${users.email} ilike ${`%${query.q}%`}`,
        ),
      )
    }
    if (query.status) conditions.push(eq(users.status, query.status))
    if (query.cursor) conditions.push(sql`${users.id} > ${query.cursor}`)
    if (query.unitId) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM ${employments} e WHERE e.user_id = ${users.id} AND e.unit_id = ${query.unitId})`,
      )
    }

    const rows = await db()
      .select()
      .from(users)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(users.id))
      .limit(limit + 1)

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const ids = page.map((r) => r.id)

    const [employmentRows, roleRows, mfaRows] = await Promise.all([
      ids.length
        ? db()
            .select({
              userId: employments.userId,
              unitId: employments.unitId,
              unitName: orgUnits.name,
              isPrimary: employments.isPrimary,
              positionId: employments.positionId,
              positionName: positions.name,
            })
            .from(employments)
            .leftJoin(orgUnits, eq(orgUnits.id, employments.unitId))
            .leftJoin(positions, eq(positions.id, employments.positionId))
            .where(inArray(employments.userId, ids))
        : [],
      ids.length
        ? db()
            .select({ userId: userRoles.userId, key: roles.key })
            .from(userRoles)
            .innerJoin(roles, eq(roles.id, userRoles.roleId))
            .where(inArray(userRoles.userId, ids))
        : [],
      ids.length
        ? db()
            .select({ userId: mfaFactors.userId })
            .from(mfaFactors)
            .where(and(inArray(mfaFactors.userId, ids), sql`${mfaFactors.verifiedAt} is not null`))
        : [],
    ])

    const mfaSet = new Set(mfaRows.map((r) => r.userId))

    return {
      items: page.map((row) => ({
        id: row.id,
        login: row.login,
        email: row.email,
        phone: row.phone,
        displayName: row.displayName,
        status: row.status as UserStatus,
        avatarUrl: row.avatarFileId ? `/api/v1/files/${row.avatarFileId}/content` : null,
        mfaEnabled: mfaSet.has(row.id),
        lastSeenAt: row.lastSeenAt,
        createdAt: row.createdAt,
        units: employmentRows
          .filter((e) => e.userId === row.id && e.unitId)
          .map((e) => ({ id: e.unitId, name: e.unitName?.ru ?? '', isPrimary: e.isPrimary })),
        positions: employmentRows
          .filter((e) => e.userId === row.id && e.positionId)
          .map((e) => ({ id: e.positionId!, name: e.positionName?.ru ?? '' })),
        roles: roleRows.filter((r) => r.userId === row.id).map((r) => r.key),
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    }
  },

  /**
   * Логины активных администраторов системы (как в `assertNotLastSystemAdmin`):
   * `kchs init` по ним решает, создавать ли первого администратора.
   */
  async activeSystemAdminLogins(database: Database = db()): Promise<string[]> {
    const rows = await database
      .select({ login: users.login })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(and(eq(roles.key, 'system_admin'), eq(users.status, 'active')))
      .orderBy(asc(users.createdAt), asc(users.login))
    return rows.map((row) => row.login)
  },

  async employments(userId: string, database: Database = db()): Promise<Employment[]> {
    const rows = await database
      .select({
        id: employments.id,
        userId: employments.userId,
        unitId: employments.unitId,
        unitName: orgUnits.name,
        positionId: employments.positionId,
        positionName: positions.name,
        isPrimary: employments.isPrimary,
        startsAt: employments.startsAt,
        endsAt: employments.endsAt,
      })
      .from(employments)
      .leftJoin(orgUnits, eq(orgUnits.id, employments.unitId))
      .leftJoin(positions, eq(positions.id, employments.positionId))
      .where(eq(employments.userId, userId))
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      unitId: row.unitId,
      unitName: row.unitName?.ru ?? '',
      positionId: row.positionId,
      positionName: row.positionName?.ru ?? null,
      isPrimary: row.isPrimary,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
    }))
  },
}

// ─── Оргструктура ────────────────────────────────────────────────────────────

export const OrgService = {
  async createUnit(tx: Executor, ctx: Ctx, input: OrgUnitInput): Promise<string> {
    const id = newId()
    await tx.insert(orgUnits).values({
      id,
      parentId: input.parentId ?? null,
      code: input.code,
      name: input.name,
      kind: input.kind,
      headUserId: input.headUserId ?? null,
      sort: input.sort,
      isActive: input.isActive,
    })
    await rebuildUnitClosure(tx, id, input.parentId ?? null)

    if (input.createSpace) {
      const spaceId = await SpaceService.create(tx, ctx, {
        key: `unit-${input.code.toLowerCase()}`.replace(/[^a-z0-9-]/g, '-'),
        name: input.name.ru,
        kind: 'unit',
        unitId: id,
      })
      await tx.update(orgUnits).set({ spaceId }).where(eq(orgUnits.id, id))
    }

    await publishEvent(tx, ctx, {
      type: 'org.unit_changed',
      object: { id, type: 'unit', title: input.name.ru },
      payload: { unitId: id, change: 'created' },
    })
    await bumpPrincipalsVersion()
    return id
  },

  async updateUnit(
    tx: Executor,
    ctx: Ctx,
    id: string,
    patch: Partial<OrgUnitInput>,
  ): Promise<void> {
    const [current] = await tx.select().from(orgUnits).where(eq(orgUnits.id, id)).limit(1)
    if (!current) throw errors.notFound('Подразделение')

    const values: Record<string, unknown> = {}
    if (patch.code !== undefined) values.code = patch.code
    if (patch.name !== undefined) values.name = patch.name
    if (patch.kind !== undefined) values.kind = patch.kind
    if (patch.headUserId !== undefined) values.headUserId = patch.headUserId
    if (patch.sort !== undefined) values.sort = patch.sort
    if (patch.isActive !== undefined) values.isActive = patch.isActive
    if (patch.parentId !== undefined) values.parentId = patch.parentId

    if (Object.keys(values).length > 0) {
      await tx
        .update(orgUnits)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(orgUnits.id, id))
    }

    if (patch.parentId !== undefined && patch.parentId !== current.parentId) {
      await rebuildUnitSubtreeClosure(tx, id, patch.parentId ?? null)
      await bumpPrincipalsVersion()
    }

    await publishEvent(tx, ctx, {
      type: 'org.unit_changed',
      object: { id, type: 'unit', title: (patch.name ?? current.name).ru },
      payload: { unitId: id, change: 'updated' },
    })
  },

  async tree(database: Database = db()): Promise<OrgUnit[]> {
    const rows = await database
      .select({
        id: orgUnits.id,
        parentId: orgUnits.parentId,
        code: orgUnits.code,
        name: orgUnits.name,
        kind: orgUnits.kind,
        headUserId: orgUnits.headUserId,
        territoryId: orgUnits.territoryId,
        spaceId: orgUnits.spaceId,
        sort: orgUnits.sort,
        isActive: orgUnits.isActive,
      })
      .from(orgUnits)
      .orderBy(asc(orgUnits.sort), asc(sql`${orgUnits.name}->>'ru'`))

    const counts = await database
      .select({ unitId: employments.unitId, count: sql<number>`count(*)::int` })
      .from(employments)
      .where(isNull(employments.endsAt))
      .groupBy(employments.unitId)
    const countMap = new Map(counts.map((c) => [c.unitId, c.count]))

    const headIds = rows.map((r) => r.headUserId).filter((v): v is string => Boolean(v))
    const heads = await UserService.refs(headIds, database)

    const childCount = new Map<string, number>()
    for (const row of rows) {
      if (row.parentId) childCount.set(row.parentId, (childCount.get(row.parentId) ?? 0) + 1)
    }

    return rows.map((row) => ({
      id: row.id,
      parentId: row.parentId,
      code: row.code,
      name: row.name,
      kind: row.kind as OrgUnit['kind'],
      head: row.headUserId ? (heads.get(row.headUserId) ?? null) : null,
      territoryId: row.territoryId,
      sort: row.sort,
      isActive: row.isActive,
      employeeCount: countMap.get(row.id) ?? 0,
      childCount: childCount.get(row.id) ?? 0,
      spaceId: row.spaceId,
    }))
  },

  /** Руководитель пользователя: глава основного подразделения, иначе — родительского. */
  async manager(userId: string, database: Database = db()): Promise<string | null> {
    const [employment] = await database
      .select({ unitId: employments.unitId })
      .from(employments)
      .where(
        and(
          eq(employments.userId, userId),
          eq(employments.isPrimary, true),
          isNull(employments.endsAt),
        ),
      )
      .limit(1)
    if (!employment) return null

    const [unit] = await database
      .select({ headUserId: orgUnits.headUserId, parentId: orgUnits.parentId })
      .from(orgUnits)
      .where(eq(orgUnits.id, employment.unitId))
      .limit(1)
    if (!unit) return null

    if (unit.headUserId && unit.headUserId !== userId) return unit.headUserId
    if (!unit.parentId) return null

    const [parent] = await database
      .select({ headUserId: orgUnits.headUserId })
      .from(orgUnits)
      .where(eq(orgUnits.id, unit.parentId))
      .limit(1)
    return parent?.headUserId ?? null
  },

  /** Подчинённые транзитивно: все сотрудники подразделений, которые возглавляет пользователь. */
  async subordinates(userId: string, database: Database = db()): Promise<string[]> {
    const headed = await database
      .select({ id: orgUnits.id })
      .from(orgUnits)
      .where(eq(orgUnits.headUserId, userId))
    if (headed.length === 0) return []

    const unitIds = headed.map((u) => u.id)
    const descendants = await database
      .select({ unitId: orgClosure.unitId })
      .from(orgClosure)
      .where(inArray(orgClosure.ancestorId, unitIds))

    const allUnits = [...new Set([...unitIds, ...descendants.map((d) => d.unitId)])]
    const rows = await database
      .select({ userId: employments.userId })
      .from(employments)
      .where(and(inArray(employments.unitId, allUnits), isNull(employments.endsAt)))
    return [...new Set(rows.map((r) => r.userId))].filter((id) => id !== userId)
  },

  async unitHead(unitId: string, database: Database = db()): Promise<string | null> {
    const [unit] = await database
      .select({ headUserId: orgUnits.headUserId })
      .from(orgUnits)
      .where(eq(orgUnits.id, unitId))
      .limit(1)
    return unit?.headUserId ?? null
  },
}

export async function rebuildUnitClosure(
  tx: Executor,
  unitId: string,
  parentId: string | null,
): Promise<void> {
  await tx.delete(orgClosure).where(eq(orgClosure.unitId, unitId))
  await tx.insert(orgClosure).values({ unitId, ancestorId: unitId, depth: 0 }).onConflictDoNothing()
  if (!parentId) return
  await tx.execute(sql`
    INSERT INTO ${orgClosure} (unit_id, ancestor_id, depth)
    SELECT ${unitId}::uuid, oc.ancestor_id, oc.depth + 1
      FROM ${orgClosure} oc WHERE oc.unit_id = ${parentId}::uuid
    ON CONFLICT DO NOTHING`)
}

export async function rebuildUnitSubtreeClosure(
  tx: Executor,
  unitId: string,
  parentId: string | null,
): Promise<void> {
  const subtree = await tx
    .select({ unitId: orgClosure.unitId, depth: orgClosure.depth })
    .from(orgClosure)
    .where(eq(orgClosure.ancestorId, unitId))

  await rebuildUnitClosure(tx, unitId, parentId)
  for (const node of subtree.sort((a, b) => a.depth - b.depth)) {
    if (node.unitId === unitId) continue
    const [row] = await tx
      .select({ parentId: orgUnits.parentId })
      .from(orgUnits)
      .where(eq(orgUnits.id, node.unitId))
      .limit(1)
    await rebuildUnitClosure(tx, node.unitId, row?.parentId ?? null)
  }
}

// ─── Делегирование ───────────────────────────────────────────────────────────

export const DelegationService = {
  async create(
    tx: Executor,
    ctx: UserCtx,
    input: {
      toUserId: string
      scope: string
      startsAt: string
      endsAt: string
      note?: string | null
    },
    fromUserId = ctx.userId,
  ): Promise<string> {
    if (input.toUserId === fromUserId) throw errors.validation('Нельзя назначить заместителем себя')
    if (new Date(input.endsAt) <= new Date(input.startsAt)) {
      throw errors.validation('Дата окончания должна быть позже начала')
    }

    const id = newId()
    await tx.insert(delegations).values({
      id,
      fromUserId,
      toUserId: input.toUserId,
      scope: input.scope,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      note: input.note ?? null,
      status: 'active',
      createdBy: ctx.userId,
    })

    await invalidatePrincipalSet(input.toUserId)
    await publishEvent(tx, ctx, {
      type: 'delegation.started',
      object: { id, type: 'delegation' },
      payload: { fromUserId, toUserId: input.toUserId, scope: input.scope },
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.delegationStarted,
        objectId: id,
        objectType: 'delegation',
        details: { fromUserId, toUserId: input.toUserId, scope: input.scope },
        severity: 'notice',
      },
      tx,
    )
    return id
  },

  async stop(tx: Executor, ctx: UserCtx, id: string): Promise<void> {
    const [row] = await tx.select().from(delegations).where(eq(delegations.id, id)).limit(1)
    if (!row) throw errors.notFound('Замещение')
    if (row.fromUserId !== ctx.userId && !ctx.isSystemAdmin) {
      throw errors.forbidden('Замещение может завершить только назначивший его')
    }

    await tx
      .update(delegations)
      .set({ status: 'finished', endsAt: sql`now()` })
      .where(eq(delegations.id, id))
    await invalidatePrincipalSet(row.toUserId)

    await publishEvent(tx, ctx, {
      type: 'delegation.ended',
      object: { id, type: 'delegation' },
      payload: { fromUserId: row.fromUserId, toUserId: row.toUserId },
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.delegationEnded,
        objectId: id,
        objectType: 'delegation',
        severity: 'notice',
      },
      tx,
    )
  },

  async activeFor(userId: string, database: Database = db()) {
    const rows = await database
      .select()
      .from(delegations)
      .where(
        and(
          eq(delegations.status, 'active'),
          or(eq(delegations.toUserId, userId), eq(delegations.fromUserId, userId)),
          sql`${delegations.startsAt} <= now() AND ${delegations.endsAt} > now()`,
        ),
      )
      .orderBy(desc(delegations.startsAt))

    const userIds = [...new Set(rows.flatMap((r) => [r.fromUserId, r.toUserId]))]
    const refs = await UserService.refs(userIds, database)

    return rows.map((row) => ({
      id: row.id,
      fromUser: refs.get(row.fromUserId)!,
      toUser: refs.get(row.toUserId)!,
      scope: row.scope as 'all' | 'approvals' | 'instructions' | 'documents' | 'meetings',
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      note: row.note,
    }))
  },
}

// ─── Группы ──────────────────────────────────────────────────────────────────

export const GroupService = {
  async list(database: Database = db()) {
    const rows = await database.select().from(groups).orderBy(asc(groups.name))
    const counts = await database
      .select({ groupId: groupMembers.groupId, count: sql<number>`count(*)::int` })
      .from(groupMembers)
      .groupBy(groupMembers.groupId)
    const countMap = new Map(counts.map((c) => [c.groupId, c.count]))
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind as 'static' | 'system',
      spaceId: row.spaceId,
      description: row.description,
      memberCount: countMap.get(row.id) ?? 0,
    }))
  },

  async create(tx: Executor, name: string, description?: string | null): Promise<string> {
    const id = newId()
    await tx.insert(groups).values({ id, name, description: description ?? null })
    return id
  },

  async setMembers(tx: Executor, groupId: string, userIds: string[]): Promise<void> {
    await tx.delete(groupMembers).where(eq(groupMembers.groupId, groupId))
    if (userIds.length > 0) {
      await tx.insert(groupMembers).values(userIds.map((userId) => ({ groupId, userId })))
    }
    await bumpPrincipalsVersion()
  },
}
