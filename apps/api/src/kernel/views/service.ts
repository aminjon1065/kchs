import { type SavedView, type ViewCreateInput, ViewDefinition } from '@kchs/contracts'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, spaces, views } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { authorize, visibleObjectsSql } from '../access/authorize.js'
import { publishEvent } from '../events/publisher.js'
import { ObjectService } from '../objects/service.js'

/**
 * Сохранённые представления списков (02-platform-kernel.md §13): фильтры,
 * сортировка, столбцы и режим CollectionView. Личное представление живёт
 * в личном пространстве, общее — в пространстве команды и видно его участникам.
 */
export const ViewService = {
  async personalSpaceId(ctx: UserCtx, executor: Executor = db()): Promise<string> {
    const [row] = await executor
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.kind, 'personal'), sql`${spaces.settings}->>'ownerId' = ${ctx.userId}`))
      .limit(1)
    if (!row) throw errors.conflict('Нет личного пространства')
    return row.id
  },

  async create(tx: Executor, ctx: UserCtx, input: ViewCreateInput): Promise<SavedView> {
    const spaceId =
      input.shared && input.spaceId ? input.spaceId : await ViewService.personalSpaceId(ctx, tx)
    if (input.shared) {
      if (!input.spaceId) throw errors.validation('Общее представление требует пространство')
      await authorize(ctx, 'create_child', input.spaceId)
    }
    const object = await ObjectService.create(tx, ctx, {
      type: 'view',
      spaceId,
      title: input.title,
      icon: 'list-filter',
      meta: { objectType: input.objectType, shared: input.shared },
    })
    await tx.insert(views).values({
      id: object.id,
      objectType: input.objectType,
      definition: input.definition as Record<string, unknown>,
      shared: input.shared,
    })
    return {
      id: object.id,
      title: input.title,
      objectType: input.objectType,
      spaceId,
      ownerId: ctx.userId,
      shared: input.shared,
      pinned: false,
      definition: input.definition,
    }
  },

  async update(
    tx: Executor,
    ctx: UserCtx,
    id: string,
    patch: { title?: string; definition?: ViewDefinition; pinned?: boolean },
  ): Promise<void> {
    if (patch.title !== undefined) await ObjectService.update(tx, ctx, id, { title: patch.title })
    const values: Record<string, unknown> = {}
    if (patch.definition !== undefined) values.definition = patch.definition
    if (patch.pinned !== undefined) values.pinned = patch.pinned
    if (Object.keys(values).length > 0) {
      await tx
        .update(views)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(views.id, id))
      if (patch.title === undefined) {
        const [row] = await tx
          .select({ type: objects.type, spaceId: objects.spaceId, title: objects.title })
          .from(objects)
          .where(eq(objects.id, id))
          .limit(1)
        await publishEvent(tx, ctx, {
          type: 'object.updated',
          object: { id, type: 'view', spaceId: row?.spaceId ?? null, title: row?.title ?? '' },
          changedFields: Object.keys(values),
        })
      }
    }
  },

  async get(id: string): Promise<SavedView | null> {
    const [row] = await db()
      .select({
        id: views.id,
        objectType: views.objectType,
        definition: views.definition,
        shared: views.shared,
        pinned: views.pinned,
        title: objects.title,
        spaceId: objects.spaceId,
        ownerId: objects.ownerId,
      })
      .from(views)
      .innerJoin(objects, eq(objects.id, views.id))
      .where(eq(views.id, id))
      .limit(1)
    return row ? toSavedView(row) : null
  },

  /** Представления типа, которые пользователь видит: свои и общие доступных пространств. */
  async list(ctx: UserCtx, objectType: string, spaceId?: string): Promise<SavedView[]> {
    const rows = await db()
      .select({
        id: views.id,
        objectType: views.objectType,
        definition: views.definition,
        shared: views.shared,
        pinned: views.pinned,
        title: objects.title,
        spaceId: objects.spaceId,
        ownerId: objects.ownerId,
      })
      .from(views)
      .innerJoin(objects, eq(objects.id, views.id))
      .where(
        and(
          eq(views.objectType, objectType),
          sql`${objects.deletedAt} is null`,
          visibleObjectsSql(ctx, 'view'),
          spaceId ? sql`(${objects.spaceId} = ${spaceId} OR ${views.shared} = false)` : undefined,
        ),
      )
      .orderBy(desc(views.pinned), asc(objects.title))
      .limit(200)
    return rows.map(toSavedView)
  },
}

function toSavedView(row: {
  id: string
  objectType: string
  definition: Record<string, unknown>
  shared: boolean
  pinned: boolean
  title: string
  spaceId: string | null
  ownerId: string | null
}): SavedView {
  return {
    id: row.id,
    title: row.title,
    objectType: row.objectType,
    spaceId: row.spaceId,
    ownerId: row.ownerId,
    shared: row.shared,
    pinned: row.pinned,
    // Старые определения дополняются значениями по умолчанию текущей версии контракта
    definition: ViewDefinition.parse(row.definition),
  }
}
