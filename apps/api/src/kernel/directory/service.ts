import {
  type AdminUser,
  type AdminUserCreateInput,
  type AdminUserPatchInput,
  type ClearanceInput,
  type Employment,
  type Locale,
  type ProfileUpdateInput,
  parseConfidentiality,
  type UserKind,
  type UserProfile,
  type UserRef,
  type UserStatus,
} from '@kchs/contracts'
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { invalidatePrincipalSet } from '~/kernel/access/principal-set.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import {
  employments,
  orgUnits,
  positions,
  roles,
  userRoles,
  users,
} from '~/kernel/directory/schema.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { secondFactor } from '~/kernel/second-factor/port.js'
import { SpaceService } from '~/kernel/spaces/service.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { actorId } from '~/shared/context.js'
import { type Database, db, type Executor, type Tx } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { newId, randomCode } from '~/shared/ids.js'
import { credentials } from './credentials.js'
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

/** Поля профиля, которые сотрудник правит сам (`PATCH /me`). */
const PROFILE_FIELDS = [
  'displayName',
  'firstName',
  'lastName',
  'middleName',
  'email',
  'phone',
  'locale',
  'timezone',
] as const satisfies ReadonlyArray<keyof ProfileUpdateInput>

export const UserService = {
  async create(
    tx: Tx,
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
    await credentials().setPassword(id, temporaryPassword, input.login, tx)
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

  async patch(tx: Tx, ctx: Ctx, userId: string, patch: AdminUserPatchInput): Promise<void> {
    const [current] = await tx.select().from(users).where(eq(users.id, userId)).limit(1)
    if (!current) throw errors.notFound('Пользователь')
    if (current.kind === 'service') {
      // Имя, почта и телефон служебной записи правятся в её разделе (ADR-0130):
      // здесь — только роли, статус и подразделение, общие для обоих видов
      const personal = ['email', 'phone', 'firstName', 'lastName', 'middleName'] as const
      if (personal.some((key) => patch[key] !== undefined)) {
        throw errors.validation('Служебная учётная запись правится в разделе служебных записей')
      }
      if (patch.roleKeys?.includes('system_admin')) {
        throw errors.validation('Служебная учётная запись не бывает администратором системы', [
          { path: 'roleKeys', message: 'system_admin', code: 'service_admin_role' },
        ])
      }
    }

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

    if (patch.unitId !== undefined || patch.positionId !== undefined) {
      const change = await assignPrimary(tx, userId, patch)
      if (change) {
        await audit(
          ctx,
          {
            action: AUDIT_ACTIONS.employmentChanged,
            objectId: userId,
            objectType: 'user',
            details: change,
          },
          tx,
        )
        await publishEvent(tx, ctx, {
          type: 'org.employment_changed',
          object: { id: userId, type: 'user' },
          payload: { userId, unitId: change.to.unitId },
        })
      }
    }

    if (patch.status === 'blocked') {
      await credentials().revokeSessions(userId, tx)
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
    await invalidatePrincipalSet(userId, tx)
  },

  /**
   * Профиль сотрудником сам (`PATCH /me`): имя, контакты, язык и пояс. Запись,
   * событие `user.updated` и сброс набора принципалов — одной транзакцией
   * вызывающего (ADR-0184): раньше профиль писал модуль входа без события.
   */
  async updateProfile(tx: Tx, ctx: Ctx, userId: string, patch: ProfileUpdateInput): Promise<void> {
    const values: Record<string, unknown> = {}
    for (const key of PROFILE_FIELDS) {
      if (patch[key] !== undefined) values[key] = patch[key]
    }
    if (Object.keys(values).length === 0) return
    const [row] = await tx
      .update(users)
      .set({ ...values, updatedAt: sql`now()` })
      .where(eq(users.id, userId))
      .returning({ displayName: users.displayName })
    if (!row) throw errors.notFound('Пользователь')
    await publishEvent(tx, ctx, {
      type: 'user.updated',
      object: { id: userId, type: 'user', title: row.displayName },
      changedFields: Object.keys(values),
    })
    await invalidatePrincipalSet(userId, tx)
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
        kind: users.kind,
        positionName: positions.name,
        unitName: orgUnits.name,
      })
      .from(users)
      .leftJoin(
        employments,
        and(
          eq(employments.userId, users.id),
          eq(employments.isPrimary, true),
          isNull(employments.endsAt),
        ),
      )
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
        kind: row.kind as UserKind,
      })
    }
    return map
  },

  async list(query: {
    q?: string
    status?: UserStatus
    unitId?: string
    roleKey?: string
    /** Сотрудники или служебные учётные записи (ADR-0130); без фильтра — все. */
    kind?: UserKind
    limit?: number
    cursor?: string
    /** Допуск к грифам показывается только администратору системы (ADR-0080). */
    withClearance?: boolean
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
    if (query.kind) conditions.push(eq(users.kind, query.kind))
    if (query.cursor) conditions.push(sql`${users.id} > ${query.cursor}`)
    if (query.unitId) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM ${employments} e WHERE e.user_id = ${users.id} AND e.unit_id = ${query.unitId} AND e.ends_at IS NULL)`,
      )
    }
    if (query.roleKey) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM ${userRoles} ur JOIN ${roles} r ON r.id = ur.role_id WHERE ur.user_id = ${users.id} AND r.key = ${query.roleKey})`,
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

    const [employmentRows, roleRows, mfaSet] = await Promise.all([
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
            .where(and(inArray(employments.userId, ids), isNull(employments.endsAt)))
            .orderBy(sql`${employments.isPrimary} desc`)
        : [],
      ids.length
        ? db()
            .select({ userId: userRoles.userId, key: roles.key })
            .from(userRoles)
            .innerJoin(roles, eq(roles.id, userRoles.roleId))
            .where(inArray(userRoles.userId, ids))
        : [],
      // Факторы входа хранит модуль identity — спрашиваем через порт ядра
      secondFactor().totpEnrolled(ids),
    ])

    return {
      items: page.map((row) => ({
        id: row.id,
        login: row.login,
        email: row.email,
        phone: row.phone,
        displayName: row.displayName,
        status: row.status as UserStatus,
        kind: row.kind as UserKind,
        description: row.description,
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
        ...(query.withClearance
          ? { clearance: parseConfidentiality(row.attributes.clearance) }
          : {}),
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    }
  },

  /**
   * Допуск к грифам (ADR-0080) — атрибут `clearance` учётной записи. Меняет
   * администратор системы с обоснованием: событие и аудит; контекст запроса
   * читает атрибут заново, открытые сокеты перепроверяет вызывающий маршрут.
   */
  async setClearance(
    tx: Tx,
    ctx: UserCtx,
    userId: string,
    input: ClearanceInput,
  ): Promise<{ from: string; to: string }> {
    const [row] = await tx
      .select({ attributes: users.attributes, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for('update')
    if (!row) throw errors.notFound('Пользователь')
    const from = parseConfidentiality(row.attributes.clearance)
    const to = input.clearance
    if (from === to) return { from, to }
    await tx
      .update(users)
      .set({
        attributes: sql`jsonb_set(${users.attributes}, '{clearance}', to_jsonb(${to}::text))`,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, userId))
    await publishEvent(tx, ctx, {
      type: 'user.clearance_changed',
      object: { id: userId, type: 'user', title: row.displayName },
      payload: { userId, from, to },
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.clearanceChanged,
        objectId: userId,
        objectType: 'user',
        severity: 'warning',
        details: { from, to, reason: input.reason },
      },
      tx,
    )
    return { from, to }
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

type Assignment = { unitId: string | null; positionId: string | null }

/**
 * Основное назначение сотрудника — перевод, а не совместительство: прежнее
 * закрывается датой и остаётся в истории, иначе сотрудник сохранил бы доступ к данным
 * прежнего подразделения (множество принципалов берёт все действующие занятости).
 * Не переданное поле не меняется; в том же подразделении должность правится на месте.
 * Возвращает было/стало или `null`, если ничего не изменилось.
 */
async function assignPrimary(
  tx: Executor,
  userId: string,
  patch: { unitId?: string | null; positionId?: string | null },
): Promise<{ from: Assignment; to: Assignment } | null> {
  const [current] = await tx
    .select({
      id: employments.id,
      unitId: employments.unitId,
      positionId: employments.positionId,
    })
    .from(employments)
    .where(
      and(
        eq(employments.userId, userId),
        eq(employments.isPrimary, true),
        isNull(employments.endsAt),
      ),
    )
    .limit(1)
  const from: Assignment = {
    unitId: current?.unitId ?? null,
    positionId: current?.positionId ?? null,
  }
  const to: Assignment = {
    unitId: patch.unitId === undefined ? from.unitId : patch.unitId,
    positionId: patch.positionId === undefined ? from.positionId : patch.positionId,
  }
  if (!to.unitId && to.positionId) {
    throw errors.validation('Должность назначается вместе с подразделением', [
      { path: 'positionId', message: 'Сначала выберите подразделение', code: 'unit_required' },
    ])
  }
  if (from.unitId === to.unitId && from.positionId === to.positionId) return null

  if (current && current.unitId === to.unitId) {
    await tx
      .update(employments)
      .set({ positionId: to.positionId })
      .where(eq(employments.id, current.id))
  } else {
    if (current) {
      await tx
        .update(employments)
        .set({ isPrimary: false, endsAt: sql`current_date` })
        .where(eq(employments.id, current.id))
    }
    if (to.unitId) {
      await tx.insert(employments).values({
        id: newId(),
        userId,
        unitId: to.unitId,
        positionId: to.positionId,
        isPrimary: true,
        startsAt: sql`current_date`,
      })
    }
  }
  return { from, to }
}
