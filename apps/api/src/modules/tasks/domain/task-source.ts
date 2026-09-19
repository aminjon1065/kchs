import { taskSourceObjectId } from '@kchs/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { loadObject } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import type { Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, type TaskSourceValue, tasks } from '~/shared/db/schema/index.js'

/** Сколько поручений источника (документа, объекта) открыто и чем закрыты остальные. */
export interface InstructionSourceStatus {
  sourceObjectId: string
  total: number
  open: number
  accepted: number
  cancelled: number
  /** Все поручения закрыты (и хотя бы одно есть): документ может стать «Исполнен». */
  allClosed: boolean
  /** Резолюции, по которым созданы поручения. */
  resolutionIds: string[]
}

/** Источники, закрытие поручений которых что-то значит: документ (резолюция) или объект. */
const TRACKED_KINDS = ['object', 'resolution']

function sourceCondition(sourceObjectId: string) {
  return and(
    eq(tasks.kind, 'instruction'),
    inArray(sql`${tasks.source}->>'kind'`, TRACKED_KINDS),
    sql`${tasks.source}->>'objectId' = ${sourceObjectId}`,
    sql`${objects.deletedAt} IS NULL`,
  )
}

/**
 * Состояние поручений источника (16-api-and-events.md §4:
 * `getStatusSummary(sourceObjectId)`): части соисполнителей считаются вместе
 * с основными поручениями, поручения в корзине — нет.
 */
export async function sourceStatus(
  sourceObjectId: string,
  executor: Executor = db(),
): Promise<InstructionSourceStatus> {
  const rows = await executor
    .select({ id: tasks.id, status: tasks.status, source: tasks.source })
    .from(tasks)
    .innerJoin(objects, eq(objects.id, tasks.id))
    .where(sourceCondition(sourceObjectId))
  const accepted = rows.filter((row) => row.status === 'accepted').length
  const cancelled = rows.filter((row) => row.status === 'cancelled').length
  const resolutionIds = [
    ...new Set(
      rows.flatMap((row) => (row.source?.kind === 'resolution' ? [row.source.resolutionId] : [])),
    ),
  ]
  return {
    sourceObjectId,
    total: rows.length,
    open: rows.length - accepted - cancelled,
    accepted,
    cancelled,
    allClosed: rows.length > 0 && accepted + cancelled === rows.length,
    resolutionIds,
  }
}

/**
 * Поручение закрыто (принято или отменено) — если по его источнику открытых
 * поручений не осталось, в той же транзакции публикуется `task.source_closed`:
 * документ переходит в «Исполнен» (08-documents.md §6), протокол — в свой
 * статус. Объект события — сам источник.
 */
export async function closeSourceIfDone(
  tx: Executor,
  ctx: Ctx,
  source: TaskSourceValue | null,
): Promise<boolean> {
  if (!source || !TRACKED_KINDS.includes(source.kind)) return false
  const sourceObjectId = taskSourceObjectId(source)
  if (!sourceObjectId) return false
  // Параллельные закрытия поручений одного источника проходят по очереди (замок
  // транзакции, а не строк — без взаимной блокировки): вторая видит закрытие
  // первой, и событие «все закрыты» публикует ровно одна
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`task-source:${sourceObjectId}`}))`)
  const status = await sourceStatus(sourceObjectId, tx)
  if (!status.allClosed) return false
  const object = await loadObject(sourceObjectId, tx)
  await publishEvent(tx, ctx, {
    type: 'task.source_closed',
    object: object
      ? { id: object.id, type: object.type, spaceId: object.spaceId, title: object.title }
      : { id: sourceObjectId, type: 'object' },
    payload: {
      sourceObjectId,
      sourceKind: source.kind,
      resolutionIds: status.resolutionIds,
      total: status.total,
      accepted: status.accepted,
      cancelled: status.cancelled,
    },
  })
  return true
}
