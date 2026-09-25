import {
  type Confidentiality,
  type ObjectSummary,
  type ObjectType,
  parseConfidentiality,
} from '@kchs/contracts'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Ctx } from '~/shared/context.js'
import { actorId } from '~/shared/context.js'
import { type Database, db, type Executor } from '~/shared/db/client.js'
import { objectAncestors, objects, recentViews } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { grantOwner } from '../access/acl-service.js'
import { effectiveConfidentialityMany } from '../access/confidentiality.js'
import type { ObjectLike } from '../access/types.js'
import { publishEvent } from '../events/publisher.js'
import { objectType, requireObjectType } from './registry.js'

export interface CreateObjectInput {
  id?: string
  type: ObjectType
  spaceId: string | null
  parentId?: string | null
  title: string
  subtitle?: string | null
  icon?: string | null
  ownerId?: string | null
  accessMode?: 'inherit' | 'restricted'
  meta?: Record<string, unknown>
  /** Гриф объекта (ADR-0080); по умолчанию `public` — без ограничения. */
  confidentiality?: Confidentiality
  /** Не публиковать `object.created` (используется при создании беседы объекта). */
  silent?: boolean
}

export interface UpdateObjectInput {
  title?: string
  subtitle?: string | null
  icon?: string | null
  meta?: Record<string, unknown>
  /** Слияние с существующим meta вместо замены. */
  mergeMeta?: boolean
}

/**
 * Сводка объекта без доступа: чип «Нет доступа» знает только тип и адрес.
 * Название, пространство, владелец и время изменения не раскрываются
 * (04-verification.md §2, п. 4).
 */
export function hiddenSummary(summary: ObjectSummary): ObjectSummary {
  return {
    id: summary.id,
    type: summary.type,
    title: '',
    subtitle: null,
    icon: summary.icon,
    spaceId: null,
    spaceName: null,
    ownerId: null,
    updatedAt: new Date(0).toISOString(),
    lifecycle: 'active',
    meta: {},
    url: summary.url,
    accessible: false,
  }
}

/**
 * Реестр объектов — создание любого объекта продукта идёт через этот сервис
 * в той же транзакции, что и запись в таблицу модуля (правило №1 CLAUDE.md).
 */
export const ObjectService = {
  async create(tx: Executor, ctx: Ctx, input: CreateObjectInput): Promise<ObjectLike> {
    requireObjectType(input.type)
    const id = input.id ?? newId()
    // `ownerId: null` — объект без личного владельца (например, беседа объекта
    // наследует доступ от него); не указан — владеет автор
    const owner = input.ownerId === undefined ? actorId(ctx) : input.ownerId

    if (input.parentId) {
      const parent = await loadRow(tx, input.parentId)
      if (!parent) throw errors.notFound('Родительский объект')
      if (parent.spaceId !== input.spaceId && input.spaceId !== null) {
        // объект живёт в пространстве родителя
        input.spaceId = parent.spaceId
      }
    }

    const [row] = await tx
      .insert(objects)
      .values({
        id,
        type: input.type,
        spaceId: input.spaceId,
        parentId: input.parentId ?? null,
        title: input.title,
        subtitle: input.subtitle ?? null,
        icon: input.icon ?? null,
        ownerId: owner,
        createdBy: actorId(ctx),
        accessMode: input.accessMode ?? 'inherit',
        meta: input.meta ?? {},
        confidentiality: input.confidentiality ?? 'public',
      })
      .returning()

    if (!row) throw errors.internal('Не удалось создать объект')

    await rebuildAncestors(tx, id, input.parentId ?? null)
    if (owner) await grantOwner(tx, id, owner)

    if (!input.silent) {
      await publishEvent(tx, ctx, {
        type: 'object.created',
        object: { id, type: input.type, spaceId: input.spaceId, title: input.title },
        payload: { type: input.type, title: input.title },
      })
    }

    return toObjectLike(row)
  },

  async update(
    tx: Executor,
    ctx: Ctx,
    id: string,
    patch: UpdateObjectInput,
    options: { expectedVersion?: number; silent?: boolean } = {},
  ): Promise<ObjectLike> {
    const current = await loadRow(tx, id)
    if (!current || current.deletedAt) throw errors.notFound()

    if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
      throw errors.preconditionFailed('Объект изменён другим пользователем', {
        expected: options.expectedVersion,
        actual: current.version,
      })
    }

    const changed: string[] = []
    const values: Record<string, unknown> = {}
    if (patch.title !== undefined && patch.title !== current.title) {
      values.title = patch.title
      changed.push('title')
    }
    if (patch.subtitle !== undefined && patch.subtitle !== current.subtitle) {
      values.subtitle = patch.subtitle
      changed.push('subtitle')
    }
    if (patch.icon !== undefined && patch.icon !== current.icon) {
      values.icon = patch.icon
      changed.push('icon')
    }
    if (patch.meta !== undefined) {
      values.meta = patch.mergeMeta ? { ...current.meta, ...patch.meta } : patch.meta
      changed.push('meta')
    }

    if (changed.length === 0) return toObjectLike(current)

    const [row] = await tx
      .update(objects)
      .set({
        ...values,
        updatedAt: sql`now()`,
        version: sql`${objects.version} + 1`,
        searchVersion: sql`${objects.searchVersion} + 1`,
      })
      .where(eq(objects.id, id))
      .returning()

    if (!row) throw errors.notFound()

    await objectType(row.type)?.lifecycle?.onUpdate?.(tx, ctx, toObjectLike(row), changed)
    if (!options.silent) {
      await publishEvent(tx, ctx, {
        type: 'object.updated',
        object: { id, type: row.type, spaceId: row.spaceId, title: row.title },
        payload: { title: row.title },
        changedFields: changed,
      })
    }
    return toObjectLike(row)
  },

  /** Перенос по дереву и/или между пространствами с пересчётом предков. */
  async move(
    tx: Executor,
    ctx: Ctx,
    id: string,
    target: { parentId?: string | null; spaceId?: string },
    options: { silent?: boolean } = {},
  ): Promise<ObjectLike> {
    const current = await loadRow(tx, id)
    if (!current || current.deletedAt) throw errors.notFound()

    const newParentId = target.parentId === undefined ? current.parentId : target.parentId
    let newSpaceId = target.spaceId ?? current.spaceId

    if (newParentId) {
      if (newParentId === id) throw errors.validation('Объект не может быть вложен сам в себя')
      const descendants = await tx
        .select({ objectId: objectAncestors.objectId })
        .from(objectAncestors)
        .where(and(eq(objectAncestors.ancestorId, id), eq(objectAncestors.objectId, newParentId)))
      if (descendants.length > 0) {
        throw errors.validation('Нельзя перенести объект в собственную ветку')
      }
      const parent = await loadRow(tx, newParentId)
      if (!parent) throw errors.notFound('Родительский объект')
      newSpaceId = parent.spaceId
    }

    await tx
      .update(objects)
      .set({
        parentId: newParentId,
        spaceId: newSpaceId,
        updatedAt: sql`now()`,
        version: sql`${objects.version} + 1`,
        searchVersion: sql`${objects.searchVersion} + 1`,
      })
      .where(eq(objects.id, id))

    await rebuildSubtreeAncestors(tx, id, newParentId)

    // Всё поддерево переезжает в новое пространство
    if (newSpaceId !== current.spaceId) {
      await tx.execute(sql`
        UPDATE ${objects} SET space_id = ${newSpaceId}, updated_at = now(),
               search_version = search_version + 1
         WHERE id IN (SELECT object_id FROM ${objectAncestors} WHERE ancestor_id = ${id})`)
    }

    const row = await loadRow(tx, id)
    if (!row) throw errors.notFound()

    // Тихий перенос — следствие доменного действия (документ ложится в журнал
    // при регистрации): о нём сообщает модуль, а права пересчитывает acl.changed
    await publishEvent(tx, ctx, {
      type: options.silent ? 'acl.changed' : 'object.moved',
      object: { id, type: row.type, spaceId: row.spaceId, title: row.title },
      payload: options.silent
        ? { objectId: id }
        : {
            fromParentId: current.parentId,
            toParentId: newParentId,
            fromSpaceId: current.spaceId,
            toSpaceId: newSpaceId,
          },
    })

    const definition = objectType(row.type)
    await definition?.lifecycle?.onMove?.(tx, ctx, toObjectLike(row), {
      spaceId: current.spaceId,
      parentId: current.parentId,
    })

    return toObjectLike(row)
  },

  /**
   * Смена грифа (ADR-0080) — это смена доступа: событие `acl.changed`
   * пересчитывает поиск (с вложениями), комнаты realtime и системные датасеты.
   */
  async setConfidentiality(
    tx: Executor,
    ctx: Ctx,
    id: string,
    confidentiality: Confidentiality,
  ): Promise<void> {
    const current = await loadRow(tx, id)
    if (!current || current.deletedAt) throw errors.notFound()
    if (current.confidentiality === confidentiality) return
    const [row] = await tx
      .update(objects)
      .set({
        confidentiality,
        updatedAt: sql`now()`,
        version: sql`${objects.version} + 1`,
        searchVersion: sql`${objects.searchVersion} + 1`,
      })
      .where(eq(objects.id, id))
      .returning()
    if (!row) throw errors.notFound()
    const object = { id, type: row.type, spaceId: row.spaceId, title: row.title }
    await publishEvent(tx, ctx, {
      type: 'object.updated',
      object,
      payload: { title: row.title },
      changedFields: ['confidentiality'],
    })
    await publishEvent(tx, ctx, { type: 'acl.changed', object, payload: { objectId: id } })
  },

  async archive(tx: Executor, ctx: Ctx, id: string): Promise<void> {
    const row = await loadRow(tx, id)
    if (!row || row.deletedAt) throw errors.notFound()
    if (row.archivedAt) return
    await objectType(row.type)?.lifecycle?.beforeArchive?.(tx, ctx, toObjectLike(row))

    await tx.execute(sql`
      UPDATE ${objects} SET archived_at = now(), updated_at = now(), search_version = search_version + 1
       WHERE id = ${id} OR id IN (SELECT object_id FROM ${objectAncestors} WHERE ancestor_id = ${id})`)

    await publishEvent(tx, ctx, {
      type: 'object.archived',
      object: { id, type: row.type, spaceId: row.spaceId, title: row.title },
    })
    await objectType(row.type)?.lifecycle?.onArchive?.(tx, ctx, toObjectLike(row))
  },

  async restore(tx: Executor, ctx: Ctx, id: string): Promise<void> {
    const row = await loadRow(tx, id)
    if (!row) throw errors.notFound()
    const from = row.deletedAt ? 'trash' : 'archive'

    await tx.execute(sql`
      UPDATE ${objects} SET archived_at = NULL, deleted_at = NULL, updated_at = now(),
             search_version = search_version + 1
       WHERE id = ${id} OR id IN (SELECT object_id FROM ${objectAncestors} WHERE ancestor_id = ${id})`)

    await publishEvent(tx, ctx, {
      type: 'object.restored',
      object: { id, type: row.type, spaceId: row.spaceId, title: row.title },
      payload: { from },
    })
    await objectType(row.type)?.lifecycle?.onRestore?.(tx, ctx, toObjectLike(row))
  },

  /** Мягкое удаление: объект и поддерево уходят в корзину на 30 дней. */
  async trash(tx: Executor, ctx: Ctx, id: string): Promise<void> {
    const row = await loadRow(tx, id)
    if (!row) throw errors.notFound()
    if (row.deletedAt) return
    await objectType(row.type)?.lifecycle?.beforeTrash?.(tx, ctx, toObjectLike(row))

    await tx.execute(sql`
      UPDATE ${objects} SET deleted_at = now(), updated_at = now(), search_version = search_version + 1
       WHERE id = ${id} OR id IN (SELECT object_id FROM ${objectAncestors} WHERE ancestor_id = ${id})`)

    await publishEvent(tx, ctx, {
      type: 'object.trashed',
      object: { id, type: row.type, spaceId: row.spaceId, title: row.title },
    })
  },

  /** Окончательное удаление: вызывает lifecycle модуля и удаляет строку. */
  async purge(tx: Executor, ctx: Ctx, id: string): Promise<void> {
    const row = await loadRow(tx, id)
    if (!row) return

    const children = await tx
      .select({ id: objects.id })
      .from(objectAncestors)
      .innerJoin(objects, eq(objects.id, objectAncestors.objectId))
      .where(eq(objectAncestors.ancestorId, id))

    for (const child of children.reverse()) {
      const childRow = await loadRow(tx, child.id)
      if (childRow) {
        await objectType(childRow.type)?.lifecycle?.onDelete?.(tx, ctx, toObjectLike(childRow))
      }
    }
    await objectType(row.type)?.lifecycle?.onDelete?.(tx, ctx, toObjectLike(row))

    await publishEvent(tx, ctx, {
      type: 'object.deleted',
      object: { id, type: row.type, spaceId: row.spaceId, title: row.title },
      payload: { type: row.type },
    })

    await tx.delete(objects).where(eq(objects.id, id))
  },

  async get(id: string, executor: Executor = db()): Promise<ObjectLike | null> {
    const row = await loadRow(executor, id)
    return row ? toObjectLike(row) : null
  },

  /** Краткие сводки для чипов, пикеров и панели «Связи». */
  async summaries(ids: string[], executor: Database = db()): Promise<Map<string, ObjectSummary>> {
    if (ids.length === 0) return new Map()
    const rows = await executor.select().from(objects).where(inArray(objects.id, ids))

    const byType = new Map<string, string[]>()
    for (const row of rows) {
      const list = byType.get(row.type) ?? []
      list.push(row.id)
      byType.set(row.type, list)
    }

    const enrichment = new Map<string, Partial<ObjectSummary>>()
    for (const [type, typeIds] of byType) {
      const definition = objectType(type)
      if (!definition?.summary) continue
      const extra = await definition.summary(typeIds)
      for (const [id, value] of extra) enrichment.set(id, value)
    }

    // Название пространства нужно карточкам, чипам и поиску
    const spaceIds = [...new Set(rows.map((r) => r.spaceId).filter((v): v is string => Boolean(v)))]
    const spaceNames = spaceIds.length
      ? new Map(
          (
            await executor
              .select({ id: objects.id, title: objects.title })
              .from(objects)
              .where(inArray(objects.id, spaceIds))
          ).map((r) => [r.id, r.title]),
        )
      : new Map<string, string>()

    // Действующий гриф (свой или объекта-хоста вложения): уведомления и Входящие
    // по объекту от «конфиденциально» показывают его без содержания (ADR-0080)
    const grifs = await effectiveConfidentialityMany(rows, executor)

    const result = new Map<string, ObjectSummary>()
    for (const row of rows) {
      const definition = objectType(row.type)
      result.set(row.id, {
        id: row.id,
        type: row.type as ObjectType,
        title: row.title,
        subtitle: row.subtitle,
        icon: row.icon ?? definition?.icon ?? null,
        spaceId: row.spaceId,
        spaceName: row.spaceId ? (spaceNames.get(row.spaceId) ?? null) : null,
        ownerId: row.ownerId,
        updatedAt: row.updatedAt,
        lifecycle: row.deletedAt ? 'trashed' : row.archivedAt ? 'archived' : 'active',
        meta: row.meta,
        url: definition?.route(row.id) ?? `/o/${row.id}`,
        accessible: true,
        confidentiality: grifs.get(row.id) ?? 'public',
        ...enrichment.get(row.id),
      })
    }
    return result
  },
}

// ─── Замыкание дерева ────────────────────────────────────────────────────────

export async function rebuildAncestors(
  tx: Executor,
  id: string,
  parentId: string | null,
): Promise<void> {
  await tx.delete(objectAncestors).where(eq(objectAncestors.objectId, id))
  if (!parentId) return
  await tx.execute(sql`
    INSERT INTO ${objectAncestors} (object_id, ancestor_id, depth)
    SELECT ${id}::uuid, ${parentId}::uuid, 1
    UNION ALL
    SELECT ${id}::uuid, oa.ancestor_id, oa.depth + 1
      FROM ${objectAncestors} oa WHERE oa.object_id = ${parentId}::uuid
    ON CONFLICT DO NOTHING`)
}

/** Пересчёт предков для объекта и всего его поддерева (после переноса). */
export async function rebuildSubtreeAncestors(
  tx: Executor,
  id: string,
  parentId: string | null,
): Promise<void> {
  const subtree = await tx
    .select({ objectId: objectAncestors.objectId, depth: objectAncestors.depth })
    .from(objectAncestors)
    .where(eq(objectAncestors.ancestorId, id))

  await rebuildAncestors(tx, id, parentId)

  const ordered = subtree.sort((a, b) => a.depth - b.depth)
  for (const node of ordered) {
    const [row] = await tx
      .select({ parentId: objects.parentId })
      .from(objects)
      .where(eq(objects.id, node.objectId))
      .limit(1)
    await rebuildAncestors(tx, node.objectId, row?.parentId ?? null)
  }
}

// ─── Вспомогательное ─────────────────────────────────────────────────────────

async function loadRow(executor: Executor, id: string) {
  const [row] = await executor.select().from(objects).where(eq(objects.id, id)).limit(1)
  return row ?? null
}

function toObjectLike(row: typeof objects.$inferSelect): ObjectLike {
  return {
    id: row.id,
    type: row.type,
    spaceId: row.spaceId,
    parentId: row.parentId,
    ownerId: row.ownerId,
    accessMode: row.accessMode,
    archivedAt: row.archivedAt,
    deletedAt: row.deletedAt,
    meta: row.meta,
    title: row.title,
    confidentiality: parseConfidentiality(row.confidentiality, 'public'),
  }
}

/** Недавние ограничены этим числом записей на пользователя (P0-E05 S03). */
export const RECENT_LIMIT = 200

/**
 * Обслуживание: обрезка недавних до RECENT_LIMIT на пользователя одним запросом.
 * Просмотр объекта только вставляет запись — лишние удаляет ночное задание,
 * чтобы не добавлять DELETE к самому частому маршруту API.
 */
export async function trimRecentViews(limit = RECENT_LIMIT): Promise<number> {
  const deleted = await db().execute(sql`
    DELETE FROM ${recentViews} rv
     USING (
       SELECT user_id, object_id,
              row_number() OVER (PARTITION BY user_id ORDER BY viewed_at DESC) AS position
         FROM ${recentViews}
     ) ranked
     WHERE rv.user_id = ranked.user_id
       AND rv.object_id = ranked.object_id
       AND ranked.position > ${limit}`)
  return deleted.count
}

/** Объекты корзины, срок хранения которых истёк (обслуживание). */
export async function expiredTrash(days = 30): Promise<string[]> {
  const rows = await db()
    .select({ id: objects.id })
    .from(objects)
    .where(
      and(
        sql`${objects.deletedAt} < now() - make_interval(days => ${days})`,
        isNull(objects.parentId),
      ),
    )
    .limit(500)
  return rows.map((r) => r.id)
}

export { toObjectLike }
