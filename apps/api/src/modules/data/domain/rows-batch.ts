import type { DatasetRowsBatch, DatasetRowsBatchResult } from '@kchs/contracts'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { JobService } from '~/kernel/jobs/service.js'
import type { Ctx } from '~/shared/context.js'
import { actorId } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { RowService } from './row-service.js'

/** Задание массовой правки строк (ADR-0097). */
export const ROWS_BATCH_JOB = { queue: 'data', name: 'dataset.rows-batch' } as const

/** Сколько операций выполняется сразу; больше — заданием с `202 + jobId`. */
export const BATCH_INLINE_LIMIT = 500

export function batchSize(input: DatasetRowsBatch): number {
  return input.insert.length + input.update.length + input.delete.length
}

/**
 * Вставка, изменение и удаление строк одной транзакцией: пачка применяется
 * целиком или не применяется вовсе. Права и политики строк проверяет
 * `RowService` — он же, что и для одиночных правок.
 */
export async function applyRowsBatch(
  ctx: Ctx,
  datasetId: string,
  input: DatasetRowsBatch,
): Promise<DatasetRowsBatchResult> {
  if (batchSize(input) === 0) throw errors.validation('Пачка пуста')

  return db().transaction(async (tx) => {
    const inserted = input.insert.length
      ? (await RowService.insert(ctx, datasetId, input.insert, tx)).length
      : 0
    let updated = 0
    for (const item of input.update) {
      // Версию можно не присылать: массовый импорт её не знает. Тогда берём
      // текущую — а `RowService.update` всё равно перечитает строку под
      // блокировкой и ответит 409, если её успели изменить
      const ver = item.ver ?? Number((await RowService.get(ctx, datasetId, item.id))._ver)
      await RowService.update(ctx, datasetId, item.id, { values: item.values, ver }, tx)
      updated += 1
    }
    const deleted = input.delete.length
      ? await RowService.remove(ctx, datasetId, input.delete, tx)
      : 0
    return { inserted, updated, deleted }
  })
}

/** Ставит пачку заданием: ответ маршрута — `202` с идентификатором задания. */
export async function queueRowsBatch(
  ctx: Ctx,
  datasetId: string,
  input: DatasetRowsBatch,
): Promise<string> {
  if (batchSize(input) === 0) throw errors.validation('Пачка пуста')
  const initiatorId = actorId(ctx)
  if (!initiatorId) throw errors.internal('Пачку ставит человек: нужен инициатор')
  return JobService.enqueue(ctx, {
    ...ROWS_BATCH_JOB,
    objectId: datasetId,
    data: { datasetId, initiatorId, input: input as unknown as Record<string, unknown> },
  })
}

/**
 * Задание выполняется правами того, кто его поставил, а не системы: иначе
 * массовая правка стала бы способом обойти политики строк (17-security.md §3).
 */
export async function runQueuedRowsBatch(data: {
  datasetId: string
  initiatorId: string
  input: DatasetRowsBatch
}): Promise<DatasetRowsBatchResult> {
  const ctx = await buildUserCtxFor(data.initiatorId)
  if (!ctx) throw errors.forbidden('Учётная запись инициатора недоступна')
  return applyRowsBatch(ctx, data.datasetId, data.input)
}
