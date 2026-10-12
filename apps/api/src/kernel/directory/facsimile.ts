import { createHash } from 'node:crypto'
import type { FacsimileState, OwnFacsimile } from '@kchs/contracts'
import { eq, inArray, sql } from 'drizzle-orm'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { actorId, type Ctx, type UserCtx } from '~/shared/context.js'
import { decryptSecret, encryptSecret } from '~/shared/crypto/secrets.js'
import { db, type Executor, type Tx } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { sanitizePng } from './png.js'
import { directory } from './port.js'
import { userFacsimiles, users } from './schema.js'

async function stateOf(executor: Executor, userId: string): Promise<FacsimileState> {
  const [row] = await executor
    .select({
      width: userFacsimiles.width,
      height: userFacsimiles.height,
      updatedAt: userFacsimiles.updatedAt,
      updatedBy: userFacsimiles.updatedBy,
    })
    .from(userFacsimiles)
    .where(eq(userFacsimiles.userId, userId))
    .limit(1)
  if (!row) return { present: false, width: null, height: null, updatedAt: null, updatedBy: null }
  const refs = row.updatedBy ? await directory().refs([row.updatedBy]) : new Map()
  return {
    present: true,
    width: row.width,
    height: row.height,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy ? (refs.get(row.updatedBy) ?? null) : null,
  }
}

async function changed(
  tx: Tx,
  ctx: Ctx,
  userId: string,
  details: { present: boolean; byAdmin: boolean; sha256?: string },
): Promise<void> {
  const [user] = await tx
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  await publishEvent(tx, ctx, {
    type: 'user.facsimile_changed',
    object: { id: userId, type: 'user', title: user?.displayName ?? null },
    payload: { present: details.present, byAdmin: details.byAdmin },
  })
  // Чужое факсимиле администратор меняет — это заметное действие
  await audit(
    ctx,
    {
      action: AUDIT_ACTIONS.facsimileChanged,
      objectId: userId,
      objectType: 'user',
      severity: details.byAdmin ? 'warning' : 'info',
      details,
    },
    tx,
  )
}

/**
 * Факсимиле сотрудника (ADR-0198). Картинку отдают только `own` — самому
 * сотруднику — и `imagesFor` — рендеру подписанного экземпляра. Администратор
 * видит лишь, есть ли факсимиле, и может заменить или удалить его.
 */
export const FacsimileService = {
  async own(ctx: UserCtx): Promise<OwnFacsimile> {
    const state = await stateOf(db(), ctx.userId)
    if (!state.present) return { ...state, dataUri: null }
    const [row] = await db()
      .select({ png: userFacsimiles.png })
      .from(userFacsimiles)
      .where(eq(userFacsimiles.userId, ctx.userId))
      .limit(1)
    return { ...state, dataUri: row ? `data:image/png;base64,${decryptSecret(row.png)}` : null }
  },

  state(userId: string): Promise<FacsimileState> {
    return stateOf(db(), userId)
  },

  async set(
    tx: Tx,
    ctx: Ctx,
    userId: string,
    base64: string,
    options: { byAdmin: boolean },
  ): Promise<void> {
    const [user] = await tx
      .select({ id: users.id, kind: users.kind })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for('update')
    if (!user) throw errors.notFound('Пользователь')
    if (user.kind === 'service') {
      throw errors.conflict('У служебной учётной записи нет подписи и факсимиле')
    }
    const { png, width, height } = sanitizePng(Buffer.from(base64, 'base64'))
    const sha256 = createHash('sha256').update(png).digest('hex')
    // Подпись человека в дампе базы — только шифром мастер-ключа (17-security.md §4)
    const sealed = encryptSecret(png.toString('base64'))
    await tx
      .insert(userFacsimiles)
      .values({ userId, png: sealed, sha256, width, height, updatedBy: actorId(ctx) })
      .onConflictDoUpdate({
        target: userFacsimiles.userId,
        set: { png: sealed, sha256, width, height, updatedBy: actorId(ctx), updatedAt: sql`now()` },
      })
    await changed(tx, ctx, userId, { present: true, byAdmin: options.byAdmin, sha256 })
  },

  async remove(tx: Tx, ctx: Ctx, userId: string, options: { byAdmin: boolean }): Promise<void> {
    const removed = await tx
      .delete(userFacsimiles)
      .where(eq(userFacsimiles.userId, userId))
      .returning({ userId: userFacsimiles.userId })
    if (removed.length === 0) return
    await changed(tx, ctx, userId, { present: false, byAdmin: options.byAdmin })
  },

  /**
   * Картинки для подписанного экземпляра (ADR-0198) — только рендеру документов:
   * `data:image/png;base64,…` и размер в пикселях. Права проверяет рендер (печать
   * документа под правами заказчика).
   */
  async imagesFor(
    userIds: string[],
  ): Promise<Map<string, { dataUri: string; width: number; height: number }>> {
    const ids = [...new Set(userIds)]
    if (ids.length === 0) return new Map()
    const rows = await db()
      .select({
        userId: userFacsimiles.userId,
        png: userFacsimiles.png,
        width: userFacsimiles.width,
        height: userFacsimiles.height,
      })
      .from(userFacsimiles)
      .where(inArray(userFacsimiles.userId, ids))
    return new Map(
      rows.map((row) => [
        row.userId,
        {
          dataUri: `data:image/png;base64,${decryptSecret(row.png)}`,
          width: row.width,
          height: row.height,
        },
      ]),
    )
  },
}
