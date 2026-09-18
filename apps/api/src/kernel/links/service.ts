import type { LinkKind, LinkView, ObjectSummary } from '@kchs/contracts'
import { and, eq, or, sql } from 'drizzle-orm'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { actorId } from '~/shared/context.js'
import { type Database, db, type Executor } from '~/shared/db/client.js'
import { dependencies, links, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { authorize } from '../access/authorize.js'
import { publishEvent } from '../events/publisher.js'
import { hiddenSummary, ObjectService } from '../objects/service.js'

/** Связи объектов (02-platform-kernel.md §3): двунаправленные по чтению. */
export const LinkService = {
  async link(
    tx: Executor,
    ctx: Ctx,
    sourceId: string,
    targetId: string,
    kind: LinkKind = 'related',
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    if (sourceId === targetId) throw errors.validation('Нельзя связать объект с самим собой')

    const [source] = await tx
      .select({
        id: objects.id,
        type: objects.type,
        spaceId: objects.spaceId,
        title: objects.title,
      })
      .from(objects)
      .where(eq(objects.id, sourceId))
      .limit(1)
    const [target] = await tx
      .select({
        id: objects.id,
        type: objects.type,
        spaceId: objects.spaceId,
        title: objects.title,
      })
      .from(objects)
      .where(eq(objects.id, targetId))
      .limit(1)
    if (!source || !target) throw errors.notFound('Связываемый объект')

    const inserted = await tx
      .insert(links)
      .values({ id: newId(), sourceId, targetId, kind, createdBy: actorId(ctx), meta })
      .onConflictDoNothing()
      .returning({ id: links.id })

    if (inserted.length === 0) return

    await publishEvent(tx, ctx, {
      type: 'object.linked',
      object: source,
      target,
      payload: { kind, targetId },
    })
  },

  async unlink(
    tx: Executor,
    ctx: Ctx,
    sourceId: string,
    targetId: string,
    kind: LinkKind,
  ): Promise<void> {
    const deleted = await tx
      .delete(links)
      .where(and(eq(links.sourceId, sourceId), eq(links.targetId, targetId), eq(links.kind, kind)))
      .returning({ id: links.id })
    if (deleted.length === 0) return

    const [source] = await tx
      .select({
        id: objects.id,
        type: objects.type,
        spaceId: objects.spaceId,
        title: objects.title,
      })
      .from(objects)
      .where(eq(objects.id, sourceId))
      .limit(1)

    await publishEvent(tx, ctx, {
      type: 'object.unlinked',
      object: source ?? null,
      payload: { kind, targetId },
    })
  },

  /**
   * Связи объекта в обе стороны. Недоступные объекты возвращаются без названия
   * (негативный тест доступа: «связи из доступного объекта»).
   */
  async listFor(ctx: UserCtx, objectId: string, database: Database = db()): Promise<LinkView[]> {
    const rows = await database
      .select()
      .from(links)
      .where(or(eq(links.sourceId, objectId), eq(links.targetId, objectId)))

    const relatedIds = rows.map((r) => (r.sourceId === objectId ? r.targetId : r.sourceId))
    const summaries = await ObjectService.summaries([...new Set(relatedIds)], database)

    const result: LinkView[] = []
    for (const row of rows) {
      const otherId = row.sourceId === objectId ? row.targetId : row.sourceId
      const summary = summaries.get(otherId)
      if (!summary) continue
      const decision = await authorize(ctx, 'view', otherId, { soft: true })
      result.push({
        id: row.id,
        kind: row.kind as LinkKind,
        direction: row.sourceId === objectId ? 'outgoing' : 'incoming',
        object: decision.allowed ? summary : hiddenSummary(summary),
        createdAt: row.createdAt,
        createdBy: row.createdBy,
      })
    }
    return result
  },

  /** Вычисляемые зависимости «использует» — происхождение и анализ влияния. */
  async setDependencies(
    tx: Executor,
    fromId: string,
    toIds: string[],
    kind: 'uses' | 'derives_from' | 'renders' = 'uses',
  ): Promise<void> {
    await tx
      .delete(dependencies)
      .where(and(eq(dependencies.fromId, fromId), eq(dependencies.kind, kind)))
    if (toIds.length === 0) return
    await tx
      .insert(dependencies)
      .values(toIds.map((toId) => ({ fromId, toId, kind })))
      .onConflictDoNothing()
  },

  /** Объекты, которые сломаются при удалении данного (инвариант №3). */
  async dependents(
    ctx: Ctx,
    objectId: string,
    database: Database = db(),
  ): Promise<ObjectSummary[]> {
    const rows = await database
      .select({ fromId: dependencies.fromId })
      .from(dependencies)
      .innerJoin(objects, eq(objects.id, dependencies.fromId))
      .where(and(eq(dependencies.toId, objectId), sql`${objects.deletedAt} is null`))
    return visibleSummaries(
      ctx,
      rows.map((r) => r.fromId),
      database,
    )
  },

  async dependenciesOf(
    ctx: Ctx,
    objectId: string,
    database: Database = db(),
  ): Promise<ObjectSummary[]> {
    const rows = await database
      .select({ toId: dependencies.toId })
      .from(dependencies)
      .where(eq(dependencies.fromId, objectId))
    return visibleSummaries(
      ctx,
      rows.map((r) => r.toId),
      database,
    )
  },

  /** Вложения объекта — связи вида `attachment`. */
  async attachments(objectId: string, database: Database = db()): Promise<string[]> {
    const rows = await database
      .select({ targetId: links.targetId })
      .from(links)
      .where(and(eq(links.sourceId, objectId), eq(links.kind, 'attachment')))
    return rows.map((r) => r.targetId)
  },

  async objectsLinkedTo(
    targetId: string,
    kind: LinkKind,
    database: Database = db(),
  ): Promise<string[]> {
    const rows = await database
      .select({ sourceId: links.sourceId })
      .from(links)
      .where(and(eq(links.targetId, targetId), eq(links.kind, kind)))
    return rows.map((r) => r.sourceId)
  },
}

/**
 * Зависимости видны всем, у кого есть доступ к объекту, но сами зависимые
 * объекты — только тем, кто может их видеть: дашборд не раскрывает названия
 * недоступных датасетов (03-access-model.md §Наследование).
 */
async function visibleSummaries(
  ctx: Ctx,
  ids: string[],
  database: Database,
): Promise<ObjectSummary[]> {
  const summaries = await ObjectService.summaries(ids, database)
  const result: ObjectSummary[] = []
  for (const [id, summary] of summaries) {
    const decision = await authorize(ctx, 'view', id, { soft: true })
    result.push(decision.allowed ? summary : hiddenSummary(summary))
  }
  return result
}
