import { type AnyColumn, and, eq, isNull, ne, notInArray, sql } from 'drizzle-orm'
import type { Ctx } from '~/shared/context.js'
import { systemCtx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { objects, spaces } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import type { ObjectLike } from '../access/types.js'
import { JobService } from '../jobs/service.js'

/**
 * Архив и удаление пространства целиком (ADR-0152). Содержимое пространства не лежит
 * под ним в `object_ancestors` (корневые объекты — без родителя), поэтому общий архив
 * ядра заморозил бы только сам объект пространства. Здесь содержимое отбирается по
 * `space_id` и получает ту же отметку времени, что и пространство: восстановление
 * возвращает ровно то, что ушло вместе с ним, а заархивированное раньше остаётся в архиве.
 */

/** Системные типы, которые не делают пространство «непустым». */
const INTERNAL_TYPES = ['conversation', 'view']

async function assertManageable(tx: Executor, spaceId: string, verb: 'archive' | 'delete') {
  const [row] = await tx
    .select({ kind: spaces.kind, settings: spaces.settings })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1)
  if (!row) throw errors.notFound('Пространство')
  const system = (row.settings as Record<string, unknown> | null)?.system
  if (row.kind === 'org' || row.kind === 'personal' || system) {
    throw errors.validation(
      verb === 'archive'
        ? 'Общее, личные и системные пространства не архивируются'
        : 'Общее, личные и системные пространства не удаляются',
      [{ path: 'id', message: 'system_space', code: 'system_space' }],
    )
  }
}

/** Содержимое пространства, кроме него самого. */
const contentOf = (spaceId: string) => and(eq(objects.spaceId, spaceId), ne(objects.id, spaceId))

/**
 * Та же отметка, что у пространства: одна транзакция — один now(), но снимок объекта
 * приходит с точностью до миллисекунд, а в базе — микросекунды.
 */
const sameMoment = (column: AnyColumn, moment: string) =>
  sql`date_trunc('milliseconds', ${column}) = ${moment}::timestamptz`

/** Переиндексация содержимого: удалённое уходит из поиска, восстановленное возвращается. */
async function reindex(tx: Executor, ctx: Ctx, spaceId: string): Promise<void> {
  await JobService.schedule(
    tx,
    systemCtx('space.lifecycle', { initiatorId: ctx.kind === 'user' ? ctx.userId : null }),
    {
      queue: 'index',
      name: 'search.reindex-space',
      data: { spaceId },
      objectId: spaceId,
    },
  )
}

export const SpaceLifecycle = {
  async beforeArchive(tx: Executor, _ctx: Ctx, space: ObjectLike): Promise<void> {
    await assertManageable(tx, space.id, 'archive')
  },

  /** Содержимое — в архив с той же отметкой, что у пространства (одна транзакция — один now()). */
  async onArchive(tx: Executor, ctx: Ctx, space: ObjectLike): Promise<void> {
    await tx
      .update(objects)
      .set({
        archivedAt: sql`now()`,
        updatedAt: sql`now()`,
        searchVersion: sql`${objects.searchVersion} + 1`,
      })
      .where(and(contentOf(space.id), isNull(objects.archivedAt), isNull(objects.deletedAt)))
    await reindex(tx, ctx, space.id)
  },

  /**
   * Удалить можно заархивированное или пустое пространство: живое с содержимым
   * сначала архивируют — так случайное удаление целого отдела невозможно.
   */
  async beforeTrash(tx: Executor, ctx: Ctx, space: ObjectLike): Promise<void> {
    await assertManageable(tx, space.id, 'delete')
    if (!space.archivedAt) {
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(objects)
        .where(
          and(
            contentOf(space.id),
            isNull(objects.deletedAt),
            notInArray(objects.type, INTERNAL_TYPES),
            sql`${objects.meta}->>'system' is null`,
          ),
        )
      if ((row?.count ?? 0) > 0) {
        throw errors.validation(
          'В пространстве есть материалы: сначала отправьте его в архив, затем удаляйте',
          [{ path: 'id', message: 'not_empty', code: 'space_not_empty' }],
        )
      }
    }
    await tx
      .update(objects)
      .set({
        deletedAt: sql`now()`,
        updatedAt: sql`now()`,
        searchVersion: sql`${objects.searchVersion} + 1`,
      })
      .where(and(contentOf(space.id), isNull(objects.deletedAt)))
    await reindex(tx, ctx, space.id)
  },

  /**
   * Восстановление из архива или корзины: возвращается содержимое с отметками самого
   * пространства (снимок до восстановления). Заархивированное или удалённое раньше
   * пространства остаётся, где было.
   */
  async onRestore(tx: Executor, ctx: Ctx, snapshot: ObjectLike): Promise<void> {
    if (snapshot.deletedAt) {
      await tx
        .update(objects)
        .set({
          deletedAt: null,
          updatedAt: sql`now()`,
          searchVersion: sql`${objects.searchVersion} + 1`,
        })
        .where(and(contentOf(snapshot.id), sameMoment(objects.deletedAt, snapshot.deletedAt)))
    }
    if (snapshot.archivedAt) {
      await tx
        .update(objects)
        .set({
          archivedAt: null,
          updatedAt: sql`now()`,
          searchVersion: sql`${objects.searchVersion} + 1`,
        })
        .where(and(contentOf(snapshot.id), sameMoment(objects.archivedAt, snapshot.archivedAt)))
    }
    await reindex(tx, ctx, snapshot.id)
  },
}
