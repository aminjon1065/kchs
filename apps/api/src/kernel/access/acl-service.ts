import {
  type AccessReason,
  type AclGrantInput,
  type EffectiveAccess,
  type Level,
  levelFromValue,
  levelValue,
  type Principal,
  type PrincipalRef,
} from '@kchs/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { actorId } from '~/shared/context.js'
import { type Database, db, type Executor } from '~/shared/db/client.js'
import {
  aclEntries,
  objectAncestors,
  objects,
  spaceMembers,
  users,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { publishEvent } from '../events/publisher.js'
import { effectiveLevel, loadObject } from './authorize.js'
import { describePrincipals } from './principal-refs.js'

export async function grantOwner(tx: Executor, objectId: string, userId: string): Promise<void> {
  await tx
    .insert(aclEntries)
    .values({
      id: newId(),
      objectId,
      principalType: 'user',
      principalId: userId,
      level: levelValue('owner'),
      grantedBy: userId,
    })
    .onConflictDoUpdate({
      target: [aclEntries.objectId, aclEntries.principalType, aclEntries.principalId],
      set: { level: levelValue('owner') },
    })
}

/** Выдача прав. Возвращает diff для события `object.shared`. */
export async function grantAccess(
  tx: Executor,
  ctx: Ctx,
  objectId: string,
  grants: AclGrantInput[],
): Promise<void> {
  if (grants.length === 0) return
  const object = await loadObject(objectId, tx)
  if (!object) throw errors.notFound()

  for (const grant of grants) {
    if (grant.level === 'owner') {
      throw errors.validation('Передача владения выполняется отдельным действием')
    }
    await tx
      .insert(aclEntries)
      .values({
        id: newId(),
        objectId,
        principalType: grant.principal.type,
        principalId: grant.principal.id,
        level: levelValue(grant.level),
        grantedBy: actorId(ctx),
        expiresAt: grant.expiresAt ?? null,
        note: grant.note ?? null,
      })
      .onConflictDoUpdate({
        target: [aclEntries.objectId, aclEntries.principalType, aclEntries.principalId],
        set: {
          level: levelValue(grant.level),
          grantedBy: actorId(ctx),
          grantedAt: sql`now()`,
          expiresAt: grant.expiresAt ?? null,
          note: grant.note ?? null,
        },
      })
  }

  await publishEvent(tx, ctx, {
    type: 'object.shared',
    object: { id: objectId, type: object.type, spaceId: object.spaceId, title: object.title },
    payload: {
      added: grants.map((g) => ({
        principal: `${g.principal.type}:${g.principal.id}`,
        level: g.level,
      })),
      removed: [],
      changed: [],
    },
  })
  await publishEvent(tx, ctx, {
    type: 'acl.changed',
    object: { id: objectId, type: object.type, spaceId: object.spaceId, title: object.title },
    payload: { objectId },
  })
}

export async function revokeAccess(
  tx: Executor,
  ctx: Ctx,
  objectId: string,
  principal: Principal,
): Promise<void> {
  const object = await loadObject(objectId, tx)
  if (!object) throw errors.notFound()
  if (principal.type === 'user' && principal.id === object.ownerId) {
    throw errors.validation('Нельзя убрать доступ владельца объекта')
  }

  await tx
    .delete(aclEntries)
    .where(
      and(
        eq(aclEntries.objectId, objectId),
        eq(aclEntries.principalType, principal.type),
        eq(aclEntries.principalId, principal.id),
      ),
    )

  await publishEvent(tx, ctx, {
    type: 'object.shared',
    object: { id: objectId, type: object.type, spaceId: object.spaceId, title: object.title },
    payload: {
      added: [],
      changed: [],
      removed: [{ principal: `${principal.type}:${principal.id}` }],
    },
  })
  await publishEvent(tx, ctx, {
    type: 'acl.changed',
    object: { id: objectId, type: object.type, spaceId: object.spaceId, title: object.title },
    payload: { objectId },
  })
}

/**
 * Разрыв или восстановление наследования (03-access-model.md §Наследование).
 * При разрыве текущие эффективные записи копируются явно — чтобы ничего
 * не «исчезло» неожиданно.
 */
export async function setAccessMode(
  tx: Executor,
  ctx: Ctx,
  objectId: string,
  mode: 'inherit' | 'restricted',
): Promise<void> {
  const object = await loadObject(objectId, tx)
  if (!object) throw errors.notFound()
  if (object.accessMode === mode) return

  if (mode === 'restricted') {
    const inherited = await tx
      .select({
        principalType: aclEntries.principalType,
        principalId: aclEntries.principalId,
        level: aclEntries.level,
      })
      .from(aclEntries)
      .where(
        sql`${aclEntries.objectId} IN (
          SELECT oa.ancestor_id FROM ${objectAncestors} oa WHERE oa.object_id = ${objectId}
        )`,
      )

    // Плюс участники пространства с их уровнями по умолчанию
    const spaceGrants = object.spaceId
      ? await tx
          .select({ userId: spaceMembers.userId, role: spaceMembers.role })
          .from(spaceMembers)
          .where(eq(spaceMembers.spaceId, object.spaceId))
      : []

    const rows = [
      ...inherited.map((r) => ({
        principalType: r.principalType,
        principalId: r.principalId,
        level: r.level,
      })),
      ...spaceGrants.map((r) => ({
        principalType: 'user',
        principalId: r.userId,
        level: levelValue(defaultLevelForRole(r.role)),
      })),
    ]

    for (const row of rows) {
      await tx
        .insert(aclEntries)
        .values({
          id: newId(),
          objectId,
          principalType: row.principalType,
          principalId: row.principalId,
          level: row.level,
          grantedBy: actorId(ctx),
          note: 'скопировано при разрыве наследования',
        })
        .onConflictDoNothing()
    }
  }

  await tx
    .update(objects)
    .set({ accessMode: mode, updatedAt: sql`now()`, version: sql`${objects.version} + 1` })
    .where(eq(objects.id, objectId))

  await publishEvent(tx, ctx, {
    type: 'object.shared',
    object: { id: objectId, type: object.type, spaceId: object.spaceId, title: object.title },
    payload: { added: [], removed: [], changed: [], accessMode: mode },
  })
}

function defaultLevelForRole(role: string): Level {
  switch (role) {
    case 'admin':
      return 'manage'
    case 'editor':
      return 'edit'
    case 'member':
      return 'comment'
    default:
      return 'view'
  }
}

/** Вкладка «Кто имеет доступ»: явные записи + участники пространства + владелец. */
export async function listEffectiveAccess(
  objectId: string,
  database: Database = db(),
): Promise<EffectiveAccess[]> {
  const object = await loadObject(objectId, database)
  if (!object) throw errors.notFound()

  const entries = await database
    .select({
      principalType: aclEntries.principalType,
      principalId: aclEntries.principalId,
      level: aclEntries.level,
      objectId: aclEntries.objectId,
      sourceTitle: objects.title,
      expiresAt: aclEntries.expiresAt,
    })
    .from(aclEntries)
    .leftJoin(objects, eq(objects.id, aclEntries.objectId))
    .where(
      object.accessMode === 'restricted'
        ? eq(aclEntries.objectId, objectId)
        : sql`${aclEntries.objectId} = ${objectId} OR ${aclEntries.objectId} IN (
             SELECT oa.ancestor_id FROM ${objectAncestors} oa WHERE oa.object_id = ${objectId})`,
    )

  const collected = new Map<
    string,
    { level: Level; reasons: AccessReason[]; principal: Principal }
  >()

  for (const entry of entries) {
    const key = `${entry.principalType}:${entry.principalId}`
    const level = levelFromValue(entry.level)
    const direct = entry.objectId === objectId
    const reason: AccessReason = {
      kind: direct ? 'explicit' : 'inherited',
      level,
      messageKey: direct ? 'access.reason.explicit' : 'access.reason.inherited',
      params: direct ? {} : { source: entry.sourceTitle ?? '' },
      sourceObjectId: entry.objectId,
    }
    const existing = collected.get(key)
    if (!existing || levelValue(level) > levelValue(existing.level)) {
      collected.set(key, {
        level,
        reasons: [...(existing?.reasons ?? []), reason],
        principal: { type: entry.principalType as Principal['type'], id: entry.principalId },
      })
    } else {
      existing.reasons.push(reason)
    }
  }

  if (object.spaceId && object.accessMode !== 'restricted') {
    const [spaceRow] = await database
      .select({ title: objects.title })
      .from(objects)
      .where(eq(objects.id, object.spaceId))
      .limit(1)
    const members = await database
      .select({ userId: spaceMembers.userId, role: spaceMembers.role })
      .from(spaceMembers)
      .where(eq(spaceMembers.spaceId, object.spaceId))

    for (const member of members) {
      const key = `user:${member.userId}`
      const level = defaultLevelForRole(member.role)
      const reason: AccessReason = {
        kind: 'space_role',
        level,
        messageKey: 'access.reason.space_role',
        params: { space: spaceRow?.title ?? '', role: member.role },
        sourceObjectId: object.spaceId,
      }
      const existing = collected.get(key)
      if (!existing) {
        collected.set(key, {
          level,
          reasons: [reason],
          principal: { type: 'user', id: member.userId },
        })
      } else {
        existing.reasons.push(reason)
        if (levelValue(level) > levelValue(existing.level)) existing.level = level
      }
    }
  }

  const refs = await describePrincipals(
    [...collected.values()].map((v) => v.principal),
    database,
  )
  const result: EffectiveAccess[] = []
  for (const [key, value] of collected) {
    const ref = refs.get(key)
    if (!ref) continue
    result.push({ principal: ref, level: value.level, reasons: value.reasons })
  }
  return result.sort((a, b) => levelValue(b.level) - levelValue(a.level))
}

/** «Проверить доступ пользователя» — Decision.reasons для конкретного человека. */
export async function explainAccessFor(
  targetCtx: UserCtx,
  objectId: string,
): Promise<{ level: Level; reasons: AccessReason[] }> {
  const object = await loadObject(objectId)
  if (!object) throw errors.notFound()
  const decision = await effectiveLevel(targetCtx, object)
  return { level: decision.level, reasons: decision.reasons }
}

/** Принципалы с правом чтения — для фильтра поискового индекса. */
export async function readPrincipalsFor(
  objectId: string,
  database: Database = db(),
): Promise<string[]> {
  const object = await loadObject(objectId, database)
  if (!object) return []

  const entries = await database
    .select({
      principalType: aclEntries.principalType,
      principalId: aclEntries.principalId,
      level: aclEntries.level,
    })
    .from(aclEntries)
    .where(
      object.accessMode === 'restricted'
        ? eq(aclEntries.objectId, objectId)
        : sql`${aclEntries.objectId} = ${objectId} OR ${aclEntries.objectId} IN (
             SELECT oa.ancestor_id FROM ${objectAncestors} oa WHERE oa.object_id = ${objectId})`,
    )

  const principals = new Set<string>()
  for (const entry of entries) {
    if (entry.level >= levelValue('view')) {
      principals.add(`${entry.principalType}:${entry.principalId}`)
    }
  }
  if (object.ownerId) principals.add(`user:${object.ownerId}`)
  if (object.spaceId && object.accessMode !== 'restricted') {
    principals.add(`space_role:${object.spaceId}:viewer`)
  }
  return [...principals]
}

/** Пользователи, у которых есть доступ к объекту (для уведомлений). */
export async function usersWithAccess(
  objectId: string,
  minLevel: Level = 'view',
): Promise<string[]> {
  const database = db()
  const object = await loadObject(objectId, database)
  if (!object) return []

  const direct = await database
    .select({ principalId: aclEntries.principalId })
    .from(aclEntries)
    .where(
      and(
        eq(aclEntries.principalType, 'user'),
        sql`${aclEntries.level} >= ${levelValue(minLevel)}`,
        object.accessMode === 'restricted'
          ? eq(aclEntries.objectId, objectId)
          : sql`${aclEntries.objectId} = ${objectId} OR ${aclEntries.objectId} IN (
               SELECT oa.ancestor_id FROM ${objectAncestors} oa WHERE oa.object_id = ${objectId})`,
      ),
    )

  const ids = new Set(direct.map((r) => r.principalId))
  if (object.ownerId) ids.add(object.ownerId)

  if (object.spaceId && object.accessMode !== 'restricted') {
    const members = await database
      .select({ userId: spaceMembers.userId })
      .from(spaceMembers)
      .where(eq(spaceMembers.spaceId, object.spaceId))
    for (const m of members) ids.add(m.userId)
  }

  const existing = await database
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), eq(users.status, 'active')))
  return existing.map((r) => r.id)
}

export type { PrincipalRef }
