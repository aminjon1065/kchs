import {
  type AccessReason,
  atLeast,
  type Decision,
  type Level,
  levelFromValue,
  levelValue,
  maxLevel,
  SPACE_ROLE_DEFAULT_LEVEL,
  type SpaceRole,
} from '@kchs/contracts'
import { and, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import {
  aclEntries,
  objectAncestors,
  objects,
  spaceMembers,
  spaces,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { actionDefinition, objectType } from '../objects/registry.js'
import type { AuthorizeOptions, ObjectLike } from './types.js'

const DENIED: Decision = {
  allowed: false,
  level: 'none',
  reasons: [{ kind: 'denied', level: 'none', messageKey: 'access.reason.denied', params: {} }],
}

function reason(
  kind: AccessReason['kind'],
  level: Level,
  params: Record<string, string | number> = {},
  sourceObjectId?: string | null,
): AccessReason {
  return {
    kind,
    level,
    messageKey: `access.reason.${kind}`,
    params,
    sourceObjectId: sourceObjectId ?? null,
  }
}

/** Загружает строку реестра в форме, пригодной для политик. */
export async function loadObject(
  id: string,
  executor: Executor = db(),
): Promise<ObjectLike | null> {
  const [row] = await executor
    .select({
      id: objects.id,
      type: objects.type,
      spaceId: objects.spaceId,
      parentId: objects.parentId,
      ownerId: objects.ownerId,
      accessMode: objects.accessMode,
      archivedAt: objects.archivedAt,
      deletedAt: objects.deletedAt,
      meta: objects.meta,
      title: objects.title,
    })
    .from(objects)
    .where(eq(objects.id, id))
    .limit(1)
  return row ?? null
}

/**
 * Определяет эффективный уровень доступа пользователя к объекту.
 * Источники проверяются в порядке 03-access-model.md; берётся максимум,
 * затем применяются атрибутные ограничения (могут только понижать).
 */
export async function effectiveLevel(
  ctx: UserCtx,
  object: ObjectLike,
  executor: Executor = db(),
): Promise<Decision> {
  const reasons: AccessReason[] = []
  let level: Level = 'none'

  // 1. Системная роль
  if (ctx.isSystemAdmin) {
    reasons.push(reason('system_role', 'owner', { role: 'system_admin' }))
    level = 'owner'
  } else if (ctx.isSecurityAuditor) {
    reasons.push(reason('system_role', 'view', { role: 'security_auditor' }))
    level = maxLevel(level, 'view')
  }

  // 2. Владелец
  if (object.ownerId && object.ownerId === ctx.userId) {
    reasons.push(reason('owner', 'owner'))
    level = 'owner'
  }

  // 3. Гостевая ссылка — доступ только к одному объекту, не выше view
  if (ctx.shareLink) {
    if (ctx.shareLink.objectId === object.id) {
      reasons.push(reason('share_link', 'view'))
      return { allowed: true, level: 'view', reasons }
    }
    if (!ctx.shareLink.includeAttachments) return DENIED
  }

  // 4. Явные записи ACL на объекте и его предках
  const aclLevel = await aclLevelFor(ctx, object, executor)
  if (aclLevel) {
    reasons.push(aclLevel.reason)
    level = maxLevel(level, aclLevel.level)
  }

  // 5. Роль в пространстве (не применяется к restricted)
  if (object.accessMode !== 'restricted' && object.spaceId) {
    const spaceLevel = await spaceRoleLevel(ctx, object.spaceId, executor)
    if (spaceLevel) {
      reasons.push(spaceLevel.reason)
      level = maxLevel(level, spaceLevel.level)
    }
  }

  // 6. Политика типа — производные права из отношений
  const definition = objectType(object.type)
  if (definition?.policy?.derive) {
    const derived = await definition.policy.derive(ctx, object)
    for (const item of derived) {
      reasons.push(item.reason)
      level = maxLevel(level, item.level)
    }
  }

  // 7. Атрибутные ограничения — только понижают
  if (definition?.policy?.cap && level !== 'none') {
    const cap = await definition.policy.cap(ctx, object)
    if (cap && levelValue(cap.level) < levelValue(level)) {
      reasons.push(cap.reason)
      level = cap.level
    }
  }

  if (level === 'none')
    return { allowed: false, level, reasons: reasons.length ? reasons : DENIED.reasons }
  return { allowed: true, level, reasons }
}

/** Максимальный уровень из ACL объекта и его предков (с учётом наследования). */
async function aclLevelFor(
  ctx: UserCtx,
  object: ObjectLike,
  executor: Executor,
): Promise<{ level: Level; reason: AccessReason } | null> {
  const principalPairs = principalPairsOf(ctx)
  if (principalPairs.length === 0) return null

  // При `restricted` наследование разорвано: только записи самого объекта
  const scopeCondition =
    object.accessMode === 'restricted'
      ? eq(aclEntries.objectId, object.id)
      : or(
          eq(aclEntries.objectId, object.id),
          sql`${aclEntries.objectId} IN (
            SELECT oa.ancestor_id FROM ${objectAncestors} oa WHERE oa.object_id = ${object.id}
          )`,
        )

  const rows = await executor
    .select({
      level: aclEntries.level,
      objectId: aclEntries.objectId,
      sourceTitle: objects.title,
    })
    .from(aclEntries)
    .leftJoin(objects, eq(objects.id, aclEntries.objectId))
    .where(
      and(
        scopeCondition,
        principalPredicate(principalPairs),
        or(isNull(aclEntries.expiresAt), sql`${aclEntries.expiresAt} > now()`),
      ),
    )

  if (rows.length === 0) return null
  let best = rows[0]!
  for (const row of rows) if (row.level > best.level) best = row

  const level = levelFromValue(best.level)
  const isDirect = best.objectId === object.id
  return {
    level,
    reason: isDirect
      ? reason('explicit', level, {}, object.id)
      : reason('inherited', level, { source: best.sourceTitle ?? '' }, best.objectId),
  }
}

async function spaceRoleLevel(
  ctx: UserCtx,
  spaceId: string,
  executor: Executor,
): Promise<{ level: Level; reason: AccessReason } | null> {
  const role = ctx.principals.spaceRoles[spaceId]
  if (!role) return null

  const [space] = await executor
    .select({ settings: spaces.settings, name: objects.title })
    .from(spaces)
    .leftJoin(objects, eq(objects.id, spaces.id))
    .where(eq(spaces.id, spaceId))
    .limit(1)

  const overrides = (space?.settings as { roleLevels?: Record<string, Level> } | undefined)
    ?.roleLevels
  const level = overrides?.[role] ?? SPACE_ROLE_DEFAULT_LEVEL[role as SpaceRole] ?? 'view'
  return {
    level,
    reason: reason('space_role', level, { space: space?.name ?? '', role }, spaceId),
  }
}

function principalPairsOf(ctx: UserCtx): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const key of ctx.principals.keys) {
    if (key.startsWith('acting_as:')) continue
    const idx = key.indexOf(':')
    if (idx < 0) continue
    pairs.push([key.slice(0, idx), key.slice(idx + 1)])
  }
  return pairs
}

function principalPredicate(pairs: Array<[string, string]>): SQL {
  const tuples = sql.join(
    pairs.map(([type, id]) => sql`(${type}, ${id})`),
    sql`, `,
  )
  return sql`(${aclEntries.principalType}, ${aclEntries.principalId}) IN (${tuples})`
}

/**
 * Единственная точка проверки прав в продукте.
 * Бросает 404 при отсутствии `view` (17-security.md §3) и 403 при нехватке уровня.
 */
export async function authorize(
  ctx: Ctx,
  action: string,
  objectRef: string | ObjectLike,
  options: AuthorizeOptions = {},
): Promise<Decision> {
  // Системный контекст: задания выполняются с уже проверенными правами
  if (ctx.kind === 'system') {
    return {
      allowed: true,
      level: 'owner',
      reasons: [reason('system_role', 'owner', { role: 'system' })],
    }
  }

  const object =
    typeof objectRef === 'string' ? (options.object ?? (await loadObject(objectRef))) : objectRef

  if (!object || (object.deletedAt && !options.allowTrashed)) {
    if (options.soft) return DENIED
    throw errors.notFound()
  }

  const decision = await effectiveLevel(ctx, object)

  // Нет даже просмотра — существование объекта не раскрываем
  if (!atLeast(decision.level, 'view')) {
    if (options.soft) return decision
    throw errors.notFound()
  }

  const definition = actionDefinition(object.type, action)
  const required: Level = definition?.minLevel ?? inferRequiredLevel(action)

  if (!atLeast(decision.level, required)) {
    if (options.soft) return { ...decision, allowed: false }
    throw errors.forbidden('Недостаточно прав для действия', { action, required })
  }

  if (definition?.capability && !ctx.capabilities.has(definition.capability)) {
    if (options.soft) return { ...decision, allowed: false }
    throw errors.forbidden('Требуется дополнительная способность', {
      action,
      capability: definition.capability,
    })
  }

  // Архивный объект — только чтение
  if (
    object.archivedAt &&
    !object.deletedAt &&
    levelValue(required) > levelValue('comment') &&
    !definition?.allowArchived
  ) {
    if (options.soft) return { ...decision, allowed: false }
    throw errors.forbidden('Объект в архиве: только чтение', { action })
  }

  return { ...decision, allowed: true }
}

/** Соглашение об именах действий, если тип не объявил их явно. */
function inferRequiredLevel(action: string): Level {
  const verb = action.split('.').pop() ?? action
  if (['view', 'read', 'get', 'list', 'download', 'export'].includes(verb)) return 'view'
  if (['comment', 'react', 'discuss'].includes(verb)) return 'comment'
  if (['share', 'move', 'archive', 'manage', 'configure'].includes(verb)) return 'manage'
  if (['delete', 'transfer'].includes(verb)) return 'owner'
  return 'edit'
}

/** Проверка глобальной способности без объекта. */
export function requireCapability(ctx: Ctx, capability: string): void {
  if (ctx.kind === 'system') return
  if (ctx.isSystemAdmin) return
  if (!ctx.capabilities.has(capability as never)) {
    throw errors.forbidden('Требуется способность', { capability })
  }
}

export function hasCapability(ctx: Ctx, capability: string): boolean {
  if (ctx.kind === 'system' || ctx.isSystemAdmin) return true
  return ctx.capabilities.has(capability as never)
}

/**
 * SQL-предикат видимости для списков: объект виден, если пользователь —
 * владелец, есть ACL на объекте или предке, или он участник пространства.
 * Политики типов добавляют свои условия (03-access-model.md §5).
 */
export function visibleObjectsSql(ctx: Ctx, objectTypeName?: string): SQL {
  if (ctx.kind === 'system') return sql`true`
  if (ctx.isSystemAdmin || ctx.isSecurityAuditor) return sql`true`

  const pairs = principalPairsOf(ctx)
  const tuples = pairs.length
    ? sql.join(
        pairs.map(([type, id]) => sql`(${type}, ${id})`),
        sql`, `,
      )
    : sql`('none','none')`

  const spaceIds = Object.keys(ctx.principals.spaceRoles)
  const spaceCondition = spaceIds.length
    ? sql`(${objects.accessMode} <> 'restricted' AND ${inArray(objects.spaceId, spaceIds)})`
    : sql`false`

  const aclCondition = sql`EXISTS (
    SELECT 1 FROM ${aclEntries} ae
     WHERE (ae.principal_type, ae.principal_id) IN (${tuples})
       AND (ae.expires_at IS NULL OR ae.expires_at > now())
       AND (
         ae.object_id = ${objects.id}
         OR (${objects.accessMode} <> 'restricted' AND ae.object_id IN (
              SELECT oa.ancestor_id FROM ${objectAncestors} oa WHERE oa.object_id = ${objects.id}
            ))
       )
  )`

  const base = sql`(${eq(objects.ownerId, ctx.userId)} OR ${spaceCondition} OR ${aclCondition})`

  const policy = objectTypeName ? objectType(objectTypeName)?.policy?.visibleSql?.(ctx) : null
  return policy ? sql`(${base} OR ${policy})` : base
}

export { atLeast, levelValue, maxLevel }

/** Участники пространства — для сводок и диалога «Поделиться». */
export async function spaceMemberIds(spaceId: string): Promise<string[]> {
  const rows = await db()
    .select({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, spaceId))
  return rows.map((r) => r.userId)
}
