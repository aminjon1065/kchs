import type { Subscriber } from '~/kernel/events/types.js'
import { DatasetQueries, DatasetRows, datasetRecord } from '~/modules/data/public.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { AppError } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'

/** Поле журнала решений дежурного: время доведения (ADR-0201). */
const PUBLISHED_FIELD = 'published_at'

interface PublishedPayload {
  sent?: string
  sourceDatasetId?: string | null
  sourceRowId?: string | null
}

/**
 * Журнал решений дежурного (ADR-0201, ADR-0202): опубликованное предупреждение
 * ставит время доведения у сообщения-источника — последней точкой цепочки
 * «сигнал → уведомление → решение → доведение». Время ставится один раз: уточнение
 * и отмена первого доведения не переписывают. Строка удалена или поля нет — тихо.
 */
export const warningSubscribers: Subscriber[] = [
  {
    name: 'warnings-decision-log',
    types: ['warning.published'],
    handle: async (event) => {
      const payload = (event.payload ?? {}) as PublishedPayload
      if (!payload.sourceDatasetId || !payload.sourceRowId || !payload.sent) return
      const datasetId = payload.sourceDatasetId
      const rowId = payload.sourceRowId
      const dataset = await datasetRecord(datasetId).catch(() => null)
      if (!dataset?.fields.some((field) => field.key === PUBLISHED_FIELD)) return
      const ctx = systemCtx('warnings.decision-log', {
        initiatorId: event.actor.userId ?? null,
      })
      try {
        const current = await DatasetQueries.row(ctx, datasetId, rowId)
        if (current.values[PUBLISHED_FIELD]) return
        await db().transaction((tx) =>
          DatasetRows.patchLatest(tx, ctx, datasetId, rowId, { [PUBLISHED_FIELD]: payload.sent }),
        )
      } catch (error) {
        if (error instanceof AppError && error.code === 'not_found') return
        logger().warn({ err: error, datasetId, rowId }, 'время доведения не записано')
        throw error
      }
    },
  },
]
