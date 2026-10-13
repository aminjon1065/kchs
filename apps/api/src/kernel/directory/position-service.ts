import { and, eq, isNull, sql } from 'drizzle-orm'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { employments, positions } from '~/kernel/directory/schema.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import type { Ctx } from '~/shared/context.js'
import type { Tx } from '~/shared/db/client.js'
import type { LangTextValue } from '~/shared/db/columns.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'

/**
 * Должности (N86): запись, событие и аудит — одной транзакцией вызывающего
 * (ADR-0177). Принципал `position:<id>` есть только у занимающих должность, а
 * занятую удалить нельзя, поэтому кэш принципалов здесь не сбрасывается.
 */
export const PositionService = {
  async create(
    tx: Tx,
    ctx: Ctx,
    input: { name: LangTextValue; rank: number; unitId?: string | null | undefined },
  ): Promise<string> {
    const id = newId()
    await tx
      .insert(positions)
      .values({ id, name: input.name, rank: input.rank, unitId: input.unitId ?? null })
    await positionChanged(tx, ctx, id, input.name, 'created')
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.positionCreated,
        objectId: id,
        objectType: 'position',
        details: { name: input.name },
      },
      tx,
    )
    return id
  },

  async update(
    tx: Tx,
    ctx: Ctx,
    id: string,
    patch: {
      name?: LangTextValue | undefined
      rank?: number | undefined
      unitId?: string | null | undefined
    },
  ): Promise<void> {
    const [row] = await tx
      .update(positions)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.rank !== undefined ? { rank: patch.rank } : {}),
        ...(patch.unitId !== undefined ? { unitId: patch.unitId } : {}),
      })
      .where(eq(positions.id, id))
      .returning({ name: positions.name })
    if (!row) throw errors.notFound('Должность')
    await positionChanged(tx, ctx, id, row.name, 'updated')
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.positionUpdated,
        objectId: id,
        objectType: 'position',
        details: patch,
      },
      tx,
    )
  },

  /** Удаление — только незанятой должности. */
  async remove(tx: Tx, ctx: Ctx, id: string): Promise<void> {
    const [taken] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(employments)
      .where(and(eq(employments.positionId, id), isNull(employments.endsAt)))
    if ((taken?.count ?? 0) > 0) {
      throw errors.conflict(
        `Должность занимают сотрудники (${taken?.count}): сначала переназначьте их`,
      )
    }
    const [row] = await tx
      .delete(positions)
      .where(eq(positions.id, id))
      .returning({ name: positions.name })
    if (!row) throw errors.notFound('Должность')
    await positionChanged(tx, ctx, id, row.name, 'deleted')
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.positionDeleted,
        objectId: id,
        objectType: 'position',
        details: { name: row.name },
      },
      tx,
    )
  },
}

async function positionChanged(
  tx: Tx,
  ctx: Ctx,
  positionId: string,
  name: LangTextValue,
  change: 'created' | 'updated' | 'deleted',
): Promise<void> {
  await publishEvent(tx, ctx, {
    type: 'org.position_changed',
    object: { id: positionId, type: 'position', title: name.ru },
    payload: { positionId, change },
  })
}
