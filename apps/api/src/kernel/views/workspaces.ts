import {
  type NamedWorkspace,
  type NamedWorkspaceInput,
  type NamedWorkspacePatch,
  type NamedWorkspaceSummary,
  WORKSPACE_VIEW_TYPE,
  WorkspaceLayout,
} from '@kchs/contracts'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, views } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { authorize, visibleObjectsSql } from '../access/authorize.js'
import { publishEvent } from '../events/publisher.js'
import { ObjectService } from '../objects/service.js'
import { ViewService } from './service.js'

const columns = {
  id: views.id,
  layout: views.definition,
  shared: views.shared,
  pinned: views.pinned,
  updatedAt: views.updatedAt,
  title: objects.title,
  spaceId: objects.spaceId,
  ownerId: objects.ownerId,
}

/**
 * Именованные рабочие пространства: объект реестра `view` c `objectType =
 * 'workspace'` (12-calendar-notifications-home.md). Личное хранится в личном
 * пространстве, общее — в пространстве команды: права — обычные права объекта.
 */
export const WorkspaceViews = {
  async create(tx: Executor, ctx: UserCtx, input: NamedWorkspaceInput): Promise<string> {
    if (input.shared && !input.spaceId) {
      throw errors.validation('Общее рабочее пространство сохраняется в пространстве команды', [
        { path: 'spaceId', message: 'required' },
      ])
    }
    if (input.shared && input.spaceId) await authorize(ctx, 'create_child', input.spaceId)
    const spaceId =
      input.shared && input.spaceId ? input.spaceId : await ViewService.personalSpaceId(ctx, tx)

    const object = await ObjectService.create(tx, ctx, {
      type: 'view',
      spaceId,
      title: input.title,
      icon: 'layout-panel-left',
      meta: { objectType: WORKSPACE_VIEW_TYPE, shared: input.shared },
    })
    await tx.insert(views).values({
      id: object.id,
      objectType: WORKSPACE_VIEW_TYPE,
      definition: input.layout as unknown as Record<string, unknown>,
      shared: input.shared,
    })
    return object.id
  },

  async get(id: string): Promise<NamedWorkspace | null> {
    const [row] = await db()
      .select(columns)
      .from(views)
      .innerJoin(objects, eq(objects.id, views.id))
      .where(
        and(
          eq(views.id, id),
          eq(views.objectType, WORKSPACE_VIEW_TYPE),
          sql`${objects.deletedAt} is null`,
        ),
      )
      .limit(1)
    if (!row) return null
    return { ...row, layout: WorkspaceLayout.parse(row.layout) }
  },

  /** Свои и общие рабочие пространства доступных пространств — для меню и палитры. */
  async list(ctx: UserCtx): Promise<NamedWorkspaceSummary[]> {
    const rows = await db()
      .select({
        ...columns,
        tabCount: sql<number>`(SELECT count(*)::int FROM jsonb_object_keys(${views.definition}->'tabs'))`,
      })
      .from(views)
      .innerJoin(objects, eq(objects.id, views.id))
      .where(
        and(
          eq(views.objectType, WORKSPACE_VIEW_TYPE),
          sql`${objects.deletedAt} is null`,
          visibleObjectsSql(ctx, 'view'),
        ),
      )
      .orderBy(desc(views.pinned), asc(objects.title))
      .limit(100)
    return rows.map(({ layout: _layout, ...row }) => row)
  },

  async update(tx: Executor, ctx: UserCtx, id: string, patch: NamedWorkspacePatch) {
    if (patch.title !== undefined) await ObjectService.update(tx, ctx, id, { title: patch.title })
    const values: Record<string, unknown> = {}
    if (patch.layout !== undefined) values.definition = patch.layout
    if (patch.pinned !== undefined) values.pinned = patch.pinned
    if (Object.keys(values).length > 0) {
      await tx
        .update(views)
        .set({ ...values, updatedAt: sql`now()` })
        .where(and(eq(views.id, id), eq(views.objectType, WORKSPACE_VIEW_TYPE)))
      // Смену названия публикует реестр; смену раскладки — здесь
      if (patch.title === undefined) {
        const [row] = await tx
          .select({ spaceId: objects.spaceId, title: objects.title })
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
}
