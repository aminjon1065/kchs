import type {
  ServiceAccount,
  ServiceAccountCreateInput,
  ServiceAccountPatchInput,
  SpaceRole,
  UserStatus,
} from '@kchs/contracts'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { getPrincipalSet, invalidatePrincipalSet } from '~/kernel/access/principal-set.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { SpaceService } from '~/kernel/spaces/service.js'
import { config } from '~/shared/config/index.js'
import type { Ctx } from '~/shared/context.js'
import { actorId } from '~/shared/context.js'
import { type Database, db, type Executor } from '~/shared/db/client.js'
import { employments, orgUnits, roles, userRoles, users } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId, randomCode } from '~/shared/ids.js'
import { assertCanAssignRoles, assertCanManageUser } from './role-policy.js'

/** Технический логин служебной записи: по нему она видна в аудите, входа по нему нет. */
const LOGIN_PREFIX = 'svc-'

/**
 * Роли служебной записи: администратором системы она не бывает — правило не
 * должно уметь больше, чем человек (contracts/automation-rule.md), а у
 * администратора системы нет ограничений доступа вовсе.
 */
async function assertServiceRoles(tx: Executor, ctx: Ctx, roleKeys: string[]): Promise<void> {
  if (roleKeys.includes('system_admin')) {
    throw errors.validation('Служебная учётная запись не бывает администратором системы', [
      { path: 'roleKeys', message: 'system_admin', code: 'service_admin_role' },
    ])
  }
  await assertCanAssignRoles(tx, ctx, roleKeys)
}

async function freeLogin(tx: Executor): Promise<string> {
  for (;;) {
    const login = `${LOGIN_PREFIX}${randomCode(8).toLowerCase()}`
    const [taken] = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.login}) = ${login}`)
      .limit(1)
    if (!taken) return login
  }
}

/** Пространства существуют: иначе членство упало бы на внешнем ключе с ошибкой 500. */
async function assertSpaces(spaceIds: string[]): Promise<void> {
  if (spaceIds.length === 0) return
  const found = await ObjectService.summaries([...new Set(spaceIds)])
  const missing = spaceIds.filter((id) => found.get(id)?.type !== 'space')
  if (missing.length > 0) {
    throw errors.validation('Нет таких пространств', [
      { path: 'spaces', message: missing.join(', '), code: 'unknown_space' },
    ])
  }
}

async function loadServiceAccount(tx: Executor, id: string) {
  const [row] = await tx
    .select({
      id: users.id,
      displayName: users.displayName,
      kind: users.kind,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
  if (row?.kind !== 'service') throw errors.notFound('Служебная учётная запись')
  return row
}

async function setRoles(tx: Executor, ctx: Ctx, userId: string, roleKeys: string[]) {
  const roleRows = roleKeys.length
    ? await tx.select().from(roles).where(inArray(roles.key, roleKeys))
    : []
  await tx.delete(userRoles).where(eq(userRoles.userId, userId))
  if (roleRows.length > 0) {
    await tx
      .insert(userRoles)
      .values(roleRows.map((role) => ({ userId, roleId: role.id, grantedBy: actorId(ctx) })))
  }
}

async function setUnit(tx: Executor, userId: string, unitId: string | null) {
  await tx.update(employments).set({ isPrimary: false }).where(eq(employments.userId, userId))
  await tx
    .update(employments)
    .set({ endsAt: sql`now()` })
    .where(and(eq(employments.userId, userId), isNull(employments.endsAt)))
  if (unitId) {
    await tx.insert(employments).values({ id: newId(), userId, unitId, isPrimary: true })
  }
}

/**
 * Набор пространств служебной записи — целиком: лишние снимаются, роли
 * выравниваются. `current` — нынешнее членство (у новой записи — пустое).
 */
async function setSpaces(
  tx: Executor,
  ctx: Ctx,
  userId: string,
  wanted: ServiceAccountCreateInput['spaces'],
  current: Record<string, string>,
) {
  const next = new Map(wanted.map((item) => [item.spaceId, item.role]))
  // Состав пространства меняет тот, кто вправе приглашать в него: иначе ведение
  // служебных записей открывало бы любое пространство в обход его администратора
  for (const [spaceId] of Object.entries(current)) {
    if (next.has(spaceId)) continue
    await authorize(ctx, 'invite', spaceId)
    await SpaceService.removeMember(tx, ctx, spaceId, userId)
  }
  for (const [spaceId, role] of next) {
    if (current[spaceId] === role) continue
    await authorize(ctx, 'invite', spaceId)
    await SpaceService.addMember(tx, ctx, spaceId, userId, role)
  }
}

export const ServiceAccountService = {
  /**
   * Новая служебная учётная запись (ADR-0130). Пароля у неё нет вовсе: вход
   * по паролю отвечает ей как неизвестному логину, а сессию ей не выдаёт ни
   * один способ входа. Интеграциям — токен API, его выпускает администратор.
   */
  async create(tx: Executor, ctx: Ctx, input: ServiceAccountCreateInput): Promise<string> {
    await assertServiceRoles(tx, ctx, input.roleKeys)
    await assertSpaces(input.spaces.map((item) => item.spaceId))

    const id = newId()
    const login = await freeLogin(tx)
    await tx.insert(users).values({
      id,
      login,
      email: null,
      displayName: input.name,
      kind: 'service',
      description: input.description,
      locale: 'ru',
      timezone: config().TZ,
      status: 'active',
      mustChangePassword: false,
    })
    if (input.unitId) await setUnit(tx, id, input.unitId)
    await setRoles(tx, ctx, id, input.roleKeys)

    await publishEvent(tx, ctx, {
      type: 'user.created',
      object: { id, type: 'user', title: input.name },
      payload: { login, kind: 'service' },
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.userCreated,
        objectId: id,
        objectType: 'user',
        details: { login, kind: 'service', roles: input.roleKeys },
        severity: 'notice',
      },
      tx,
    )
    // Членство — после записи пользователя: подписчики пространств читают его имя
    await setSpaces(tx, ctx, id, input.spaces, {})
    await invalidatePrincipalSet(id)
    return id
  },

  async update(tx: Executor, ctx: Ctx, id: string, patch: ServiceAccountPatchInput): Promise<void> {
    const current = await loadServiceAccount(tx, id)
    const changesRolesOrStatus = patch.roleKeys !== undefined || patch.status !== undefined
    await assertCanManageUser(tx, ctx, id, { changesRolesOrStatus })
    if (patch.roleKeys) await assertServiceRoles(tx, ctx, patch.roleKeys)
    if (patch.spaces) await assertSpaces(patch.spaces.map((item) => item.spaceId))

    const values: Record<string, unknown> = {}
    if (patch.name !== undefined) values.displayName = patch.name
    if (patch.description !== undefined) values.description = patch.description
    if (patch.status !== undefined) values.status = patch.status
    if (Object.keys(values).length > 0) {
      await tx
        .update(users)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(users.id, id))
    }

    if (patch.roleKeys) {
      await setRoles(tx, ctx, id, patch.roleKeys)
      await audit(
        ctx,
        {
          action: AUDIT_ACTIONS.roleAssigned,
          objectId: id,
          objectType: 'user',
          details: { roles: patch.roleKeys, kind: 'service' },
          severity: 'warning',
        },
        tx,
      )
      await publishEvent(tx, ctx, {
        type: 'user.roles_changed',
        object: { id, type: 'user', title: current.displayName },
        payload: { userId: id, roles: patch.roleKeys },
      })
    }
    if (patch.unitId !== undefined) {
      await setUnit(tx, id, patch.unitId)
      await publishEvent(tx, ctx, {
        type: 'org.employment_changed',
        object: { id, type: 'user' },
        payload: { userId: id, unitId: patch.unitId },
      })
    }
    if (patch.spaces) {
      await setSpaces(tx, ctx, id, patch.spaces, (await getPrincipalSet(id)).spaceRoles)
    }
    // Токены API заблокированной записи перестают действовать сами: контекст
    // запроса не строится для неактивной учётной записи
    if (patch.status === 'blocked' && current.status !== 'blocked') {
      await publishEvent(tx, ctx, {
        type: 'user.blocked',
        object: { id, type: 'user' },
        payload: { reason: null },
      })
      await audit(
        ctx,
        {
          action: AUDIT_ACTIONS.userBlocked,
          objectId: id,
          objectType: 'user',
          severity: 'warning',
        },
        tx,
      )
    }

    await publishEvent(tx, ctx, {
      type: 'user.updated',
      object: { id, type: 'user', title: patch.name ?? current.displayName },
      changedFields: Object.keys(values),
    })
    await invalidatePrincipalSet(id)
  },

  /** Все служебные учётные записи — для консоли и выбора `run_as` правила. */
  async list(database: Database = db()): Promise<ServiceAccount[]> {
    const rows = await database
      .select({
        id: users.id,
        login: users.login,
        name: users.displayName,
        description: users.description,
        status: users.status,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.kind, 'service'))
      .orderBy(asc(users.displayName), asc(users.id))
    return describe(rows, database)
  },

  async get(id: string, database: Database = db()): Promise<ServiceAccount> {
    const rows = await database
      .select({
        id: users.id,
        login: users.login,
        name: users.displayName,
        description: users.description,
        status: users.status,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(and(eq(users.id, id), eq(users.kind, 'service')))
      .limit(1)
    const [account] = await describe(rows, database)
    if (!account) throw errors.notFound('Служебная учётная запись')
    return account
  },
}

type Row = {
  id: string
  login: string
  name: string
  description: string | null
  status: string
  createdAt: string
}

/** Роли, подразделение и пространства служебных записей — одним проходом. */
async function describe(rows: Row[], database: Database): Promise<ServiceAccount[]> {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const [roleRows, unitRows] = await Promise.all([
    database
      .select({ userId: userRoles.userId, key: roles.key })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(inArray(userRoles.userId, ids)),
    database
      .select({ userId: employments.userId, unitId: orgUnits.id, name: orgUnits.name })
      .from(employments)
      .innerJoin(orgUnits, eq(orgUnits.id, employments.unitId))
      .where(
        and(
          inArray(employments.userId, ids),
          eq(employments.isPrimary, true),
          isNull(employments.endsAt),
        ),
      ),
  ])
  const memberships = new Map(
    await Promise.all(ids.map(async (id) => [id, (await getPrincipalSet(id)).spaceRoles] as const)),
  )
  const spaceIds = [...new Set([...memberships.values()].flatMap((item) => Object.keys(item)))]
  const titles = await ObjectService.summaries(spaceIds, database)

  return rows.map((row) => {
    const unit = unitRows.find((item) => item.userId === row.id)
    return {
      id: row.id,
      login: row.login,
      name: row.name,
      description: row.description,
      status: row.status as UserStatus,
      roles: roleRows.filter((item) => item.userId === row.id).map((item) => item.key),
      unit: unit ? { id: unit.unitId, name: unit.name.ru } : null,
      spaces: Object.entries(memberships.get(row.id) ?? {}).map(([spaceId, role]) => ({
        spaceId,
        title: titles.get(spaceId)?.title ?? '',
        role: role as SpaceRole,
      })),
      createdAt: row.createdAt,
    }
  })
}
