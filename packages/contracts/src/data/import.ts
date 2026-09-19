import { z } from 'zod'
import { LangText, Timestamp, Uuid } from '../common/primitives.js'
import { FieldFormat, FieldSemantic } from '../fields/field-def.js'
import type { STORED_FIELD_TYPES } from './dataset.js'

/**
 * Импорт файла в датасет (06-analytics-engine.md §2, ADR-0046):
 * анализ (движок, синхронно, по выборке) → сопоставление (UI) → выполнение
 * (движок нормализует файл → воркер загружает его в таблицу датасета).
 * Геоформаты читает GDAL движка (07-gis-engine.md §8, ADR-0068): Shapefile
 * архивом zip, GeoPackage, KML/KMZ и GPX.
 */
export const IMPORT_FORMATS = [
  'csv',
  'tsv',
  'xlsx',
  'xls',
  'json',
  'ndjson',
  'geojson',
  'shp',
  'gpkg',
  'kml',
  'kmz',
  'gpx',
] as const
export const ImportFormat = z.enum(IMPORT_FORMATS)
export type ImportFormat = z.infer<typeof ImportFormat>

/** Геоформаты со слоями: столбцы — поля слоя, геометрия объекта — отдельно (ADR-0068). */
export const IMPORT_LAYER_FORMATS = [
  'shp',
  'gpkg',
  'kml',
  'kmz',
  'gpx',
] as const satisfies readonly ImportFormat[]

/** Система координат — код EPSG; геометрия датасета всегда пересчитывается в EPSG:4326. */
export const CrsCode = z.string().regex(/^EPSG:\d{4,6}$/, 'система координат: EPSG:<код>')

/** Частые системы координат исходных данных (подсказка мастера импорта). */
export const IMPORT_CRS_PRESETS = [
  'EPSG:4326',
  'EPSG:32642',
  'EPSG:32643',
  'EPSG:3857',
  'EPSG:4284',
  'EPSG:28412',
  'EPSG:28413',
] as const

/** Типы, которые распознаёт и загружает импорт фазы 1. */
export const IMPORT_FIELD_TYPES = [
  'text',
  'long_text',
  'integer',
  'number',
  'decimal',
  'money',
  'percent',
  'boolean',
  'date',
  'datetime',
  'time',
  'select',
  'identifier',
  'url',
  'email',
  'phone',
  'json',
  'geometry',
  // Код или название единицы справочника территорий → её идентификатор (ADR-0057)
  'territory',
] as const satisfies readonly (typeof STORED_FIELD_TYPES)[number][]
export const ImportFieldType = z.enum(IMPORT_FIELD_TYPES)
export type ImportFieldType = z.infer<typeof ImportFieldType>

/** Размеры выборок и предельные значения — общие для API, движка и интерфейса. */
export const IMPORT_LIMITS = {
  /** Строк в выборке анализа (типы, семантика, примеры). */
  analyzeSampleRows: 2000,
  /** Строк предпросмотра в мастере. */
  previewRows: 50,
  /** Примеров значений на столбец. */
  samplesPerColumn: 5,
  /** Столбцов в файле. */
  maxColumns: 500,
  /** Размер файла, байт (крупнее — только через задание с потоковым чтением). */
  maxFileBytes: 2 * 1024 ** 3,
  /** Время анализа, мс — синхронный вызов движка. */
  analyzeTimeoutMs: 15_000,
  /** Примеров строк на вид изменения в предпросмотре обновления (ADR-0068). */
  diffSampleRows: 20,
} as const

/** Как читать файл. Пустые значения — автоопределение движком. */
export const ImportOptions = z.object({
  format: ImportFormat.optional(),
  encoding: z.string().max(40).optional(),
  delimiter: z.string().min(1).max(1).optional(),
  /** Лист книги Excel. */
  sheet: z.string().max(200).optional(),
  /** Сколько строк сверху пропустить до заголовка. */
  skipRows: z.number().int().min(0).max(1000).optional(),
  /** Строк заголовка (0 — заголовка нет, столбцы называются по номеру). */
  headerRows: z.number().int().min(0).max(5).optional(),
  decimal: z.enum(['.', ',']).optional(),
  thousands: z.enum(['', ' ', ',', '.', "'"]).optional(),
  /** Порядок частей даты, если по данным его не определить (01.02.2026). */
  dateOrder: z.enum(['dmy', 'mdy', 'ymd']).optional(),
  /** Слой геоформата (GeoPackage, KML, GPX, несколько .shp в архиве). */
  layer: z.string().max(200).optional(),
  /**
   * Система координат исходных данных, если в файле её нет или она указана
   * неверно: координаты пересчитываются из неё в EPSG:4326.
   */
  crs: CrsCode.optional(),
})
export type ImportOptions = z.infer<typeof ImportOptions>

/** Как из столбцов файла собирается геометрия. */
export const ImportGeometry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('latlon'), lat: z.number().int(), lon: z.number().int() }),
  z.object({ kind: z.literal('wkt'), column: z.number().int() }),
  z.object({ kind: z.literal('geojson'), column: z.number().int() }),
  /** Объекты GeoJSON и геоформатов: геометрия объекта, поля — из свойств или полей слоя. */
  z.object({ kind: z.literal('features') }),
])
export type ImportGeometry = z.infer<typeof ImportGeometry>

/**
 * Откуда система координат: `file` — из файла (.prj, слой GeoPackage, «crs»
 * GeoJSON, EWKT), `option` — указана пользователем, `default` — WGS 84 по
 * стандарту формата (KML, GPX, GeoJSON) или по координатам в градусах,
 * `unknown` — не определена: координаты не в градусах, нужно выбрать систему.
 */
export const IMPORT_CRS_SOURCES = ['file', 'option', 'default', 'unknown'] as const

/** Геометрия файла по выборке анализа (07-gis-engine.md §8, ADR-0068). */
export const ImportGeoInfo = z.object({
  /** Система координат исходных данных; null — не определена. */
  crs: z.string().nullable(),
  crsName: z.string().nullable(),
  crsSource: z.enum(IMPORT_CRS_SOURCES),
  /** Тип геометрии слоя или выборки (Point, MultiPolygon…); null — разные или нет. */
  geometryType: z.string().nullable(),
  /** Слои файла и выбранный слой (для форматов со слоями). */
  layers: z.array(
    z.object({
      name: z.string(),
      rows: z.number().int().nonnegative(),
      geometryType: z.string().nullable(),
    }),
  ),
  layer: z.string().nullable(),
  /** Геометрий выборки, исправленных при чтении (самопересечения, петли). */
  fixed: z.number().int().nonnegative(),
  /** Геометрий выборки, которые не загрузятся (попадут в файл ошибок). */
  invalid: z.number().int().nonnegative(),
  /** Охват выборки в WGS 84 после пересчёта: [запад, юг, восток, север]. */
  bbox: z.array(z.number()).length(4).nullable(),
})
export type ImportGeoInfo = z.infer<typeof ImportGeoInfo>

export const ImportColumn = z.object({
  index: z.number().int().nonnegative(),
  /** Заголовок столбца как в файле. */
  name: z.string(),
  /** Предлагаемый ключ поля (snake_case, латиница). */
  key: z.string(),
  type: ImportFieldType,
  semantic: FieldSemantic,
  /** Распознанный формат: даты — шаблон, числа — десятичный знак. */
  format: FieldFormat.optional(),
  /** Доля пустых значений в выборке, 0…1. */
  emptyShare: z.number().min(0).max(1),
  /** Все значения выборки различны — кандидат в ключ. */
  unique: z.boolean(),
  /** Значений выборки, не приводимых к предложенному типу. */
  invalid: z.number().int().nonnegative(),
  samples: z.array(z.string()),
})
export type ImportColumn = z.infer<typeof ImportColumn>

export const ImportAnalyzeInput = z.object({
  fileId: Uuid,
  options: ImportOptions.default({}),
})
export type ImportAnalyzeInput = z.infer<typeof ImportAnalyzeInput>

export const ImportAnalysis = z.object({
  format: ImportFormat,
  encoding: z.string().nullable(),
  delimiter: z.string().nullable(),
  decimal: z.enum(['.', ',']).nullable(),
  thousands: z.string().nullable(),
  dateOrder: z.enum(['dmy', 'mdy', 'ymd']).nullable(),
  sheets: z.array(z.object({ name: z.string(), rows: z.number().int().nonnegative() })),
  sheet: z.string().nullable(),
  skipRows: z.number().int().nonnegative(),
  headerRows: z.number().int().nonnegative(),
  /** Оценка числа строк данных; точное число — после выполнения. */
  rowEstimate: z.number().int().nonnegative(),
  approx: z.boolean(),
  columns: z.array(ImportColumn),
  /** Первые строки как в файле (текст ячеек) — для предпросмотра. */
  preview: z.array(z.array(z.string().nullable())),
  /** Предлагаемая геометрия: пара широта/долгота, WKT, GeoJSON. */
  geometry: ImportGeometry.nullable(),
  /** Система координат, слои и качество геометрий; null — геометрии в файле нет. */
  geo: ImportGeoInfo.nullable().default(null),
  warnings: z.array(z.string()),
})
export type ImportAnalysis = z.infer<typeof ImportAnalysis>

/** Сопоставление: столбец файла → поле датасета. Несопоставленные столбцы не загружаются. */
export const ImportMappingItem = z.object({
  column: z.number().int().nonnegative(),
  fieldKey: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z_][a-z0-9_]*$/, 'ключ поля: snake_case'),
  label: LangText,
  type: ImportFieldType,
  semantic: FieldSemantic,
  format: FieldFormat.optional(),
  required: z.boolean().default(false),
})
export type ImportMappingItem = z.infer<typeof ImportMappingItem>

export const IMPORT_MODES = ['replace', 'append', 'upsert', 'sync'] as const
export const ImportMode = z.enum(IMPORT_MODES)
export type ImportMode = z.infer<typeof ImportMode>

export const ImportTarget = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('new'),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    spaceId: Uuid,
    parentId: Uuid.nullable().optional(),
  }),
  z.object({ kind: z.literal('existing'), datasetId: Uuid, mode: ImportMode }),
])
export type ImportTarget = z.infer<typeof ImportTarget>

export const ImportRunInput = z
  .object({
    fileId: Uuid,
    options: ImportOptions.default({}),
    target: ImportTarget,
    mapping: z.array(ImportMappingItem).min(1).max(500),
    /** Геометрия датасета (поле `geometryField` типа geometry). */
    geometry: ImportGeometry.nullable().optional(),
    geometryField: z.string().max(64).optional(),
    /** Ключевые поля: первичный ключ нового датасета и ключ upsert/sync. */
    key: z.array(z.string()).max(8).default([]),
    /** «Загрузить валидные» (skip) или «остановить при ошибках» (stop). */
    onError: z.enum(['skip', 'stop']).default('skip'),
    /**
     * Предпросмотр изменений (ADR-0068): после разбора файла импорт ждёт
     * публикации со сводкой «добавлено / изменено / удалено» по ключу.
     * Только для `upsert` и `sync` в существующий датасет.
     */
    review: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    const keys = new Set(input.mapping.map((item) => item.fieldKey))
    if (keys.size !== input.mapping.length) {
      ctx.addIssue({ code: 'custom', message: 'Ключи полей повторяются', path: ['mapping'] })
    }
    for (const key of input.key) {
      if (!keys.has(key)) {
        ctx.addIssue({ code: 'custom', message: `Ключ «${key}» не сопоставлен`, path: ['key'] })
      }
    }
    const mode = input.target.kind === 'existing' ? input.target.mode : 'replace'
    if ((mode === 'upsert' || mode === 'sync') && input.key.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'Для обновления по ключу нужен ключ', path: ['key'] })
    }
    if (input.review && mode !== 'upsert' && mode !== 'sync') {
      ctx.addIssue({
        code: 'custom',
        message: 'Предпросмотр изменений — только при обновлении по ключу',
        path: ['review'],
      })
    }
  })
export type ImportRunInput = z.infer<typeof ImportRunInput>

/**
 * Состояния импорта: `comparing` — файл сравнивается с датасетом по ключу,
 * `review` — сводка изменений готова и ждёт публикации или отмены (ADR-0068).
 */
export const IMPORT_STATUSES = [
  'queued',
  'normalizing',
  'comparing',
  'review',
  'loading',
  'succeeded',
  'failed',
  'cancelled',
] as const
export const ImportStatus = z.enum(IMPORT_STATUSES)
export type ImportStatus = z.infer<typeof ImportStatus>

/** Импорт завершён: дальше его состояние не меняется. */
export const IMPORT_FINAL_STATUSES = [
  'succeeded',
  'failed',
  'cancelled',
] as const satisfies readonly ImportStatus[]

/** Значение поля в примере изменения — текстом, как в таблице; null — пусто. */
export const ImportDiffChange = z.object({
  field: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  /** Значение скрыто маской политики столбцов. */
  masked: z.boolean().optional(),
})
export type ImportDiffChange = z.infer<typeof ImportDiffChange>

export const ImportDiffRow = z.object({
  /** Значения ключевых полей текстом, в порядке ключа датасета. */
  key: z.array(z.string().nullable()),
  /** Номер строки файла; у удаляемых строк — null. */
  row: z.number().int().nullable(),
  /** Изменённые поля (у добавленных и удаляемых — первые поля строки). */
  changes: z.array(ImportDiffChange),
  /** Строка была удалена и вернётся. */
  restored: z.boolean().optional(),
})
export type ImportDiffRow = z.infer<typeof ImportDiffRow>

/** Сводка изменений перед публикацией (ADR-0068). */
export const ImportDiff = z.object({
  /** Версия датасета, с которой сравнивался файл. */
  baseVersion: z.number().int(),
  added: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  /** Строки, которые `sync` пометит удалёнными. */
  deleted: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  /** Повторы ключа в файле: остаётся последняя строка. */
  duplicates: z.number().int().nonnegative(),
  /** Примеры по видам; пусто — примеры скрыты политикой строк. */
  samples: z.object({
    added: z.array(ImportDiffRow),
    changed: z.array(ImportDiffRow),
    deleted: z.array(ImportDiffRow),
  }),
})
export type ImportDiff = z.infer<typeof ImportDiff>

export const ImportStats = z.object({
  /** Строк данных в файле. */
  rows: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  /** Строк с ошибками (не загружены при onError=skip). */
  errors: z.number().int().nonnegative(),
})
export type ImportStats = z.infer<typeof ImportStats>

export const ImportRecord = z.object({
  id: Uuid,
  datasetId: Uuid,
  fileId: Uuid,
  status: ImportStatus,
  stats: ImportStats,
  /** Файл ошибок: строка, столбец, значение, причина (CSV). */
  errorsFileId: Uuid.nullable(),
  /** Первые ошибки для показа без скачивания. */
  errorSample: z.array(
    z.object({
      row: z.number().int(),
      column: z.string(),
      value: z.string().nullable(),
      reason: z.string(),
    }),
  ),
  jobId: Uuid.nullable(),
  version: z.number().int().nullable(),
  message: z.string().nullable(),
  /** Импорт ждёт публикации после предпросмотра изменений (ADR-0068). */
  review: z.boolean(),
  /** Сводка изменений — с состояния `review`; в списке импортов — без примеров. */
  diff: ImportDiff.nullable(),
  createdAt: Timestamp,
  finishedAt: Timestamp.nullable(),
})
export type ImportRecord = z.infer<typeof ImportRecord>

/**
 * Нормализованный файл — договор движка и воркера (ADR-0046): CSV UTF-8
 * без заголовка; первый столбец — номер строки файла (как в файле ошибок), дальше
 * столбцы в порядке сопоставления (геометрия — последней),
 * разделитель «,», кавычки «"», пустое без кавычек — NULL. Значения
 * приведены к виду, который понимает `COPY … FROM STDIN (FORMAT csv)`:
 */
export const NORMALIZED_VALUE_FORMATS = {
  integer: 'десятичные цифры со знаком',
  number: 'точка — десятичный разделитель, без разделителей тысяч',
  decimal: 'как number',
  money: 'как number',
  percent: 'доля или проценты — как в столбце (format.scale)',
  boolean: 'true | false',
  date: 'YYYY-MM-DD',
  datetime: 'ISO 8601 со смещением (YYYY-MM-DDTHH:MM:SS+HH:MM)',
  time: 'HH:MM:SS',
  json: 'текст JSON',
  geometry: 'EWKT с SRID=4326',
  text: 'как есть (без управляющих символов, кроме перевода строки)',
} as const

/** Ошибки строк — второй CSV: номер строки файла, ключ поля, значение, код причины. */
export const IMPORT_ERROR_CODES = [
  'invalid_number',
  'invalid_integer',
  'invalid_date',
  'invalid_datetime',
  'invalid_time',
  'invalid_boolean',
  'invalid_json',
  'invalid_geometry',
  'required',
  'too_long',
  'duplicate_key',
  'unknown_territory',
  'ambiguous_territory',
] as const
export const ImportErrorCode = z.enum(IMPORT_ERROR_CODES)
export type ImportErrorCode = z.infer<typeof ImportErrorCode>
