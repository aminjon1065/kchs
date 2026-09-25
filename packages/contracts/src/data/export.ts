import { z } from 'zod'
import { FilterNode } from '../common/filter.js'
import { BigIntString, Uuid } from '../common/primitives.js'
import { QuerySortItem, QuerySpec } from './query.js'

/**
 * Экспорт датасета (P1-E03 S04, ADR-0056): задание очереди `exports` читает
 * строки с политиками запросившего на момент выполнения и кладёт файл в
 * хранилище экспортов (срок хранения 30 дней); скачать может только он.
 * GeoPackage, Shapefile (zip) и KML собирает движок из выгрузки воркера (ADR-0068).
 */
export const DATASET_EXPORT_FORMATS = [
  'csv',
  'xlsx',
  'json',
  'geojson',
  'gpkg',
  'shp',
  'kml',
] as const
export const DatasetExportFormat = z.enum(DATASET_EXPORT_FORMATS)
export type DatasetExportFormat = z.infer<typeof DatasetExportFormat>

/** Форматы, которым нужно поле геометрии. */
export const DATASET_GEO_EXPORT_FORMATS = [
  'geojson',
  'gpkg',
  'shp',
  'kml',
] as const satisfies readonly DatasetExportFormat[]

/** Форматы, которые из выгрузки воркера (GeoJSONSeq) собирает движок GDAL. */
export const DATASET_ENGINE_EXPORT_FORMATS = [
  'gpkg',
  'shp',
  'kml',
] as const satisfies readonly DatasetExportFormat[]
export type DatasetEngineExportFormat = (typeof DATASET_ENGINE_EXPORT_FORMATS)[number]

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

/**
 * Выгрузка результата запроса (ADR-0159): «Исследование», сохранённый график и
 * плитка дашборда — CSV или XLSX тем же писателем, что у экспорта датасета.
 * Результат считается заново с политиками запросившего, файл отдаётся сразу в
 * ответе (сводки маленькие; сырые строки — не больше `QUERY_EXPORT_MAX_ROWS`).
 * Нужны способность `data.export` и действие `export` на каждом датасете запроса.
 */
export const QUERY_EXPORT_FORMATS = ['csv', 'xlsx'] as const
export const QueryExportFormat = z.enum(QUERY_EXPORT_FORMATS)
export type QueryExportFormat = z.infer<typeof QueryExportFormat>

/** Больше строк результат не выгружает — ответ помечается заголовком `truncated`. */
export const QUERY_EXPORT_MAX_ROWS = 100_000

/** Заголовки ответа выгрузки: сколько строк в файле и обрезан ли результат. */
export const QUERY_EXPORT_HEADERS = {
  rows: 'x-kchs-export-rows',
  truncated: 'x-kchs-export-truncated',
} as const

const ExportLabels = z.record(z.string().max(160), z.string().max(200)).default({})

export const QueryExportInput = z.object({
  spec: QuerySpec,
  params: z.record(z.string(), z.unknown()).default({}),
  format: QueryExportFormat,
  /** Имя файла без расширения и даты: название графика, датасета или плитки. */
  name: z.string().trim().min(1).max(200),
  /** Подписи столбцов на языке интерфейса — как на экране (разрезы и меры). */
  labels: ExportLabels,
})
export type QueryExportInput = z.infer<typeof QueryExportInput>

/** Выгрузка данных плитки-графика дашборда — с фильтрами дашборда, как на экране. */
export const DashboardTileExportInput = z.object({
  tileId: z.string().min(1).max(64),
  filters: z.record(z.string(), z.unknown()).default({}),
  format: QueryExportFormat,
  labels: ExportLabels,
})
export type DashboardTileExportInput = z.infer<typeof DashboardTileExportInput>
