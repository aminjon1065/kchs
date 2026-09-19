import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'
import { QuerySpec, SPATIAL_OPS } from './query.js'

/**
 * Пространственный анализ — объект реестра типа `analysis` (07-gis-engine.md
 * §10, ADR-0069): воспроизводимый запрос с шагом `spatial`, который задание
 * материализует в новый датасет с правами запустившего на момент выполнения.
 */
export const ANALYSIS_STATUSES = ['draft', 'queued', 'running', 'succeeded', 'failed'] as const
export const AnalysisStatus = z.enum(ANALYSIS_STATUSES)
export type AnalysisStatus = z.infer<typeof AnalysisStatus>

/** Вид анализа — операция последнего шага `spatial` запроса. */
export const AnalysisKind = z.enum(SPATIAL_OPS)
export type AnalysisKind = z.infer<typeof AnalysisKind>

/** Больше строк результат анализа не материализует — задание завершается ошибкой. */
export const ANALYSIS_MAX_ROWS = 1_000_000

export const AnalysisCreateInput = z.object({
  name: z.string().trim().min(1).max(200),
  spaceId: Uuid,
  parentId: Uuid.nullable().optional(),
  /** Запрос анализа: источник, отбор строк и шаг `spatial` (последний — вид анализа). */
  query: QuerySpec,
  /** Название датасета-результата; по умолчанию — название анализа. */
  outputName: z.string().trim().min(1).max(200).optional(),
  /** Запустить сразу после создания. */
  run: z.boolean().default(true),
})
export type AnalysisCreateInput = z.infer<typeof AnalysisCreateInput>

export const AnalysisRecord = z.object({
  id: Uuid,
  name: z.string(),
  spaceId: Uuid,
  parentId: Uuid.nullable(),
  kind: AnalysisKind,
  query: QuerySpec,
  outputName: z.string(),
  /** Датасеты-источники (основной, цели) — зависимости анализа. */
  inputDatasetIds: z.array(Uuid),
  /** Датасет-результат последнего успешного запуска. */
  outputDatasetId: Uuid.nullable(),
  status: AnalysisStatus,
  /** Задание последнего запуска (прогресс — `/jobs/:id`). */
  jobId: Uuid.nullable(),
  /** Строк в результате последнего успешного запуска. */
  rowCount: z.number().int().nonnegative().nullable(),
  /** Причина последней неудачи. */
  error: z.string().nullable(),
  lastRunAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type AnalysisRecord = z.infer<typeof AnalysisRecord>

export const AnalysisRunStarted = z.object({ jobId: Uuid })
export type AnalysisRunStarted = z.infer<typeof AnalysisRunStarted>

/** Результат задания анализа (`JobRecord.result`). */
export const AnalysisRunResult = z.object({
  datasetId: Uuid,
  rows: z.number().int().nonnegative(),
  /** Результат записан в новый датасет, а не заменил строки прежнего. */
  created: z.boolean(),
})
export type AnalysisRunResult = z.infer<typeof AnalysisRunResult>
