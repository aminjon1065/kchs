import { DatasetSettings } from '@kchs/contracts'
import { and, eq, lt, max, sql } from 'drizzle-orm'
import { db } from '~/shared/db/client.js'
import { logger } from '~/shared/logger/index.js'
import { historyName, historySql } from '../infra/physical.js'
import { datasets, datasetVersions } from '../schema.js'

/** Строк истории за одно удаление: короткие транзакции не мешают правке строк. */
const BATCH = 10_000
/** Пачек на датасет за проход — остаток удалится следующей ночью. */
const MAX_BATCHES = 50

export interface RetentionReport {
  datasets: number
  deleted: number
}

/**
 * Срок хранения истории строк (ADR-0173). У датасета с `historyRetentionDays`
 * история удаляется целыми версиями: все версии, созданные раньше срока, — по
 * индексу `dataset_version`, пачками. Версия либо хранит всю свою историю, либо
 * ни одной строки, поэтому откат к оставшимся версиям считается верно, а к
 * удалённым — недоступен с понятной причиной. Строки истории без номера версии
 * (таблицы до ADR-0062) удаляются по времени правки.
 */
export const HistoryRetention = {
  async prune(): Promise<RetentionReport> {
    const candidates = await db()
      .select({ id: datasets.id, settings: datasets.settings })
      .from(datasets)
      .where(sql`${datasets.settings} ->> 'historyRetentionDays' IS NOT NULL`)
    const report: RetentionReport = { datasets: 0, deleted: 0 }
    for (const candidate of candidates) {
      const settings = DatasetSettings.parse(candidate.settings ?? {})
      if (!settings.trackHistory || settings.historyRetentionDays === null) continue
      try {
        const deleted = await pruneDataset(candidate.id, settings.historyRetentionDays)
        report.datasets++
        report.deleted += deleted
      } catch (error) {
        // Один датасет не держит остальные: его история дочистится следующим проходом
        logger().warn({ err: error, datasetId: candidate.id }, 'история строк датасета не очищена')
      }
    }
    return report
  },

  /** Граница срока хранения: версии, созданные раньше неё, истории уже не имеют. */
  cutoff(days: number): Date {
    return new Date(Date.now() - days * 86_400_000)
  },
}

async function pruneDataset(datasetId: string, days: number): Promise<number> {
  const history = historyName(datasetId)
  const [table] = await db().execute<{ exists: boolean }>(
    sql`SELECT to_regclass(${`ds.${history}`}) IS NOT NULL AS exists`,
  )
  if (!table?.exists) return 0
  const cutoff = HistoryRetention.cutoff(days)
  const [last] = await db()
    .select({ number: max(datasetVersions.number) })
    .from(datasetVersions)
    .where(
      and(
        eq(datasetVersions.datasetId, datasetId),
        lt(datasetVersions.createdAt, cutoff.toISOString()),
      ),
    )
  const target = historySql(datasetId)
  // Сначала версии старше срока — по индексу номера версии; затем строки таблиц до
  // ADR-0062 без номера — по времени правки. Пачки общие на обе части
  const phases = [
    last?.number ? sql`dataset_version <= ${last.number}` : null,
    sql`dataset_version IS NULL AND changed_at < ${cutoff.toISOString()}::timestamptz`,
  ].filter((phase) => phase !== null)

  let deleted = 0
  let batches = 0
  for (const condition of phases) {
    while (batches < MAX_BATCHES) {
      batches++
      const removed = await db().execute(
        sql`DELETE FROM ${target}
             WHERE id IN (SELECT id FROM ${target} WHERE ${condition} LIMIT ${BATCH})`,
      )
      deleted += removed.count
      if (removed.count < BATCH) break
    }
  }
  return deleted
}
