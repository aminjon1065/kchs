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
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { Ctx } from '~/shared/context.js'
import { actorId } from '~/shared/context.js'
import { type Database, db, type Executor } from '~/shared/db/client.js'
import { aclEntries, links, objects, spaceMembers, users } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { publishEvent } from '../events/publisher.js'
import { objectType } from '../objects/registry.js'
import { aclScope, inheritanceBoundary, loadObject } from './authorize.js'
import { clearanceAllowsSql, effectiveConfidentiality } from './confidentiality.js'
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

/**
 * Выдача прав. Возвращает diff для события `object.shared`. `quiet` — права
 * выданы как следствие другого действия (исполнитель поручения): уведомления
 * «с вами поделились» нет, о деле сообщит модуль.
 */
export async function grantAccess(
  tx: Executor,
  ctx: Ctx,
  objectId: string,
  grants: AclGrantInput[],
  options: { quiet?: boolean } = {},
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
      ...(options.quiet ? { quiet: true } : {}),
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
    // Копируются только действовавшие права: записи предков до текущей границы
    // наследования и роли пространства, если разрыва выше нет. Иначе разрыв
    // вложенной папки выдал бы доступ, закрытый разрывом выше по дереву
    const boundary = await inheritanceBoundary(object, tx)
    const inherited = await tx
      .select({
        principalType: aclEntries.principalType,
        principalId: aclEntries.principalId,
        level: aclEntries.level,
      })
      .from(aclEntries)
      .where(
        and(
          aclScope(objectId, boundary),
          sql`${aclEntries.objectId} <> ${objectId}`,
          or(isNull(aclEntries.expiresAt), sql`${aclEntries.expiresAt} > now()`),
        ),
      )

    // Плюс участники пространства с их уровнями по умолчанию
    const spaceGrants =
      object.spaceId && boundary === null
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

    // Ничего не исчезает: у принципала остаётся максимальный из действовавших уровней
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
        .onConflictDoUpdate({
          target: [aclEntries.objectId, aclEntries.principalType, aclEntries.principalId],
          set: { level: sql`greatest(${aclEntries.level}, excluded.level)` },
        })
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
  const boundary = await inheritanceBoundary(object, database)

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
    .where(aclScope(objectId, boundary))

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

  if (object.spaceId && boundary === null) {
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

/** Принципалы с правом чтения — для фильтра поискового индекса. */
export async function readPrincipalsFor(
  objectId: string,
  database: Executor = db(),
  options: { attachments?: boolean } = {},
): Promise<string[]> {
  const object = await loadObject(objectId, database)
  if (!object) return []
  const boundary = await inheritanceBoundary(object, database)

  const entries = await database
    .select({
      principalType: aclEntries.principalType,
      principalId: aclEntries.principalId,
      level: aclEntries.level,
    })
    .from(aclEntries)
    .where(
      and(
        aclScope(objectId, boundary),
        or(isNull(aclEntries.expiresAt), sql`${aclEntries.expiresAt} > now()`),
      ),
    )

  const principals = new Set<string>()
  for (const entry of entries) {
    if (entry.level >= levelValue('view')) {
      principals.add(`${entry.principalType}:${entry.principalId}`)
    }
  }
  if (object.ownerId) principals.add(`user:${object.ownerId}`)
  if (object.spaceId && boundary === null) {
    principals.add(`space_role:${object.spaceId}:viewer`)
  }
  // Производные права политики типа: участники шагов маршрута (ADR-0079),
  // руководители исполнителя поручения (ADR-0082)
  const policy = objectType(object.type)?.policy
  if (policy?.principals) {
    for (const key of await policy.principals(object, database)) principals.add(key)
  }

  // Вложение читают все, кто читает объект, к которому оно прикреплено (как в authorize)
  if (options.attachments !== false) {
    const hosts = await database
      .select({ id: links.sourceId })
      .from(links)
      .innerJoin(objects, eq(objects.id, links.sourceId))
      .where(
        and(eq(links.targetId, objectId), eq(links.kind, 'attachment'), isNull(objects.deletedAt)),
      )
      .limit(50)
    for (const host of hosts) {
      for (const key of await readPrincipalsFor(host.id, database, { attachments: false })) {
        principals.add(key)
      }
    }
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
  const boundary = await inheritanceBoundary(object, database)

  // aclScope уже в скобках: без них OR внутри and() захватывал бы чужие типы и уровни
  const direct = await database
    .select({ principalId: aclEntries.principalId })
    .from(aclEntries)
    .where(
      and(
        eq(aclEntries.principalType, 'user'),
        sql`${aclEntries.level} >= ${levelValue(minLevel)}`,
        aclScope(objectId, boundary),
        or(isNull(aclEntries.expiresAt), sql`${aclEntries.expiresAt} > now()`),
      ),
    )

  const ids = new Set(direct.map((r) => r.principalId))
  if (object.ownerId) ids.add(object.ownerId)

  if (object.spaceId && boundary === null) {
    const members = await database
      .select({ userId: spaceMembers.userId })
      .from(spaceMembers)
      .where(eq(spaceMembers.spaceId, object.spaceId))
    for (const m of members) ids.add(m.userId)
  }

  if (ids.size === 0) return []
  // Получатель без допуска к грифу объекта о нём не узнаёт (ADR-0080)
  const cleared = clearanceAllowsSql(
    await effectiveConfidentiality(objectId, database),
    sql`${users.attributes}`,
  )
  const existing = await database
    .select({ id: users.id })
    .from(users)
    .where(
      and(inArray(users.id, [...ids]), eq(users.status, 'active'), ...(cleared ? [cleared] : [])),
    )
  return existing.map((r) => r.id)
}

export type { PrincipalRef }
