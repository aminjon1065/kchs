import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { acknowledgmentRequests, acknowledgments } from '~/shared/db/schema/index.js'
import { newId } from '~/shared/ids.js'
import { loadObject } from '../access/authorize.js'
import { publishEvent } from '../events/publisher.js'
import { InboxService } from '../inbox/service.js'
import type { ProcessObserver, ProcessStepChange } from '../process/registry.js'
import { Acknowledgments } from './service.js'

const PENDING = and(isNull(acknowledgments.acknowledgedAt), isNull(acknowledgments.cancelledAt))

/** Состояния назначенного, при которых ожидание снимается: шаг отменён или передан. */
const DROPPED = new Set(['cancelled', 'delegated'])

/**
 * Шаг маршрута `acknowledge` в учёте ознакомления (ADR-0084): активация —
 * запрос с источником `process` (дела Входящих открывает сам движок),
 * решение «Ознакомлен» — отметка; заодно закрываются ожидания сотрудника по
 * объекту из запросов без кода второго фактора. Снятие с шага, отмена шага и
 * маршрута снимают ожидания. Всё — в транзакции перехода движка.
 */
async function stepChanged(tx: Executor, ctx: Ctx, change: ProcessStepChange): Promise<void> {
  const objectId = change.instance.objectId
  const [existing] = await tx
    .select({ id: acknowledgmentRequests.id })
    .from(acknowledgmentRequests)
    .where(eq(acknowledgmentRequests.processStepId, change.step.id))
    .limit(1)
  let requestId = existing?.id ?? null
  if (!requestId) {
    const pending = change.entries.filter((entry) => entry.state === 'pending')
    if (pending.length === 0 && change.step.status !== 'active') return
    const outcome = await Acknowledgments.request(tx, ctx, {
      objectId,
      source: 'process',
      processStepId: change.step.id,
      userIds: pending.map((entry) => entry.userId),
      dueAt: change.step.dueAt,
    })
    requestId = outcome.requestId
    if (!requestId) return
  }

  const rows = await tx
    .select()
    .from(acknowledgments)
    .where(eq(acknowledgments.requestId, requestId))
  const byUser = new Map(rows.map((row) => [row.userId, row]))
  const cancelled: string[] = []
  const present = new Set<string>()

  for (const entry of change.entries) {
    present.add(entry.userId)
    const row = byUser.get(entry.userId)
    const open = row && !row.acknowledgedAt && !row.cancelledAt
    if (!row) {
      // Назначенный добавлен на ходу (переназначение): ожидание — ему
      if (entry.state === 'pending') {
        await tx.insert(acknowledgments).values({
          id: newId(),
          requestId,
          objectId,
          userId: entry.userId,
          source: 'process',
          dueAt: change.step.dueAt,
        })
      }
      continue
    }
    if (entry.state === 'acknowledged' && open) {
      await acknowledgedByStep(tx, ctx, {
        objectId,
        requestId,
        rowId: row.id,
        userId: entry.userId,
        actorId: entry.actorId && entry.actorId !== entry.userId ? entry.actorId : null,
      })
    } else if (DROPPED.has(entry.state) && open) {
      cancelled.push(entry.userId)
    }
  }
  // Снят с шага (переназначение) или шаг отменён — ожидание снимается
  for (const row of rows) {
    if (!row.acknowledgedAt && !row.cancelledAt) {
      if (!present.has(row.userId) || change.step.status === 'cancelled') cancelled.push(row.userId)
    }
  }
  if (change.step.status === 'cancelled') {
    await tx
      .update(acknowledgmentRequests)
      .set({ cancelledAt: sql`now()` })
      .where(
        and(eq(acknowledgmentRequests.id, requestId), isNull(acknowledgmentRequests.cancelledAt)),
      )
  }
  const dropped = [...new Set(cancelled)]
  if (dropped.length === 0) return
  await tx
    .update(acknowledgments)
    .set({ cancelledAt: sql`now()` })
    .where(
      and(
        eq(acknowledgments.requestId, requestId),
        inArray(acknowledgments.userId, dropped),
        PENDING,
      ),
    )
  const object = await loadObject(objectId, tx)
  await publishEvent(tx, ctx, {
    type: 'acknowledgment.cancelled',
    object: object
      ? { id: object.id, type: object.type, spaceId: object.spaceId, title: object.title }
      : { id: objectId, type: change.instance.objectType },
    payload: { requestId, userIds: dropped },
  })
}

/**
 * Решение шага «Ознакомлен»: отметка ожидания шага и ожиданий сотрудника по
 * объекту из запросов без кода второго фактора (с кодом — только отметкой
 * с кодом); дела Входящих этих запросов закрываются.
 */
async function acknowledgedByStep(
  tx: Executor,
  ctx: Ctx,
  input: {
    objectId: string
    requestId: string
    rowId: string
    userId: string
    actorId: string | null
  },
): Promise<void> {
  const others = await tx
    .select({ id: acknowledgments.id })
    .from(acknowledgments)
    .innerJoin(acknowledgmentRequests, eq(acknowledgmentRequests.id, acknowledgments.requestId))
    .where(
      and(
        eq(acknowledgments.objectId, input.objectId),
        eq(acknowledgments.userId, input.userId),
        ne(acknowledgments.requestId, input.requestId),
        eq(acknowledgmentRequests.requireSecondFactor, false),
        PENDING,
      ),
    )
  const marked = await tx
    .update(acknowledgments)
    .set({ acknowledgedAt: sql`now()`, actorId: input.actorId })
    .where(and(inArray(acknowledgments.id, [input.rowId, ...others.map((row) => row.id)]), PENDING))
    .returning({ requestId: acknowledgments.requestId })
  if (marked.length === 0) return
  if (others.length > 0) {
    await InboxService.resolve(
      tx,
      ctx,
      {
        objectId: input.objectId,
        kind: 'acknowledge',
        dedupeKey: `ack:${input.objectId}`,
        userId: input.userId,
      },
      'resolved',
      'acknowledged',
    )
  }
  const object = await loadObject(input.objectId, tx)
  if (!object) return
  await publishEvent(tx, ctx, {
    type: 'acknowledgment.acknowledged',
    object: { id: object.id, type: object.type, spaceId: object.spaceId, title: object.title },
    payload: {
      userId: input.userId,
      requestIds: [...new Set(marked.map((row) => row.requestId))],
      secondFactor: false,
    },
  })
}

export const processAcknowledgments: ProcessObserver = {
  name: 'acknowledgments',
  stepTypes: ['acknowledge'],
  stepChanged,
}
