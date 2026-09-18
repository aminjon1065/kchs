import { z } from 'zod'
import { FilterNode } from '../common/filter.js'
import { BigIntString, Uuid } from '../common/primitives.js'
import { QuerySortItem } from './query.js'

/**
 * Экспорт датасета (P1-E03 S04, ADR-0056): задание очереди `exports` читает
 * строки с политиками запросившего на момент выполнения и кладёт файл в
 * хранилище экспортов (срок хранения 30 дней); скачать может только он.
 */
export const DATASET_EXPORT_FORMATS = ['csv', 'xlsx', 'json', 'geojson'] as const
export const DatasetExportFormat = z.enum(DATASET_EXPORT_FORMATS)
export type DatasetExportFormat = z.infer<typeof DatasetExportFormat>

/** Больше строк экспорт не выгружает — результат помечается `truncated`. */
export const DATASET_EXPORT_MAX_ROWS = 1_000_000

export const DatasetExportInput = z.object({
  format: DatasetExportFormat,
  where: FilterNode.optional(),
  search: z.string().trim().max(200).optional(),
  sort: z.array(QuerySortItem).max(8).default([]),
  /** Поля в порядке выгрузки; по умолчанию — все видимые поля схемы. */
  fields: z.array(z.string().min(1).max(64)).min(1).max(500).optional(),
  /** Только эти строки (выделение в таблице). */
  ids: z.array(BigIntString).min(1).max(10_000).optional(),
})
export type DatasetExportInput = z.infer<typeof DatasetExportInput>

export const DatasetExportStarted = z.object({ jobId: Uuid })
export type DatasetExportStarted = z.infer<typeof DatasetExportStarted>

/** Результат задания экспорта (`JobRecord.result`). */
export const DatasetExportResult = z.object({
  fileName: z.string(),
  format: DatasetExportFormat,
  rows: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  /** Строк было больше `DATASET_EXPORT_MAX_ROWS`. */
  truncated: z.boolean(),
})
export type DatasetExportResult = z.infer<typeof DatasetExportResult>

export const DatasetExportDownload = z.object({ url: z.string() })
export type DatasetExportDownload = z.infer<typeof DatasetExportDownload>
