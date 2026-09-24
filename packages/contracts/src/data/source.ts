import { z } from 'zod'
import { LangText, Timestamp, Uuid } from '../common/primitives.js'
import { DatasetFieldInput, StoredFieldType } from './dataset.js'

/**
 * Источник датасета — объект реестра типа `source` (05-data-model.md §Данные,
 * 14-automation-integrations.md §5, ADR-0107): подключение к внешней СУБД
 * (интеграция вида `postgres`/`mysql`) плюс запрос или таблица, из которой
 * заданием наполняется датасет. Учётные данные живут в интеграции и наружу не
 * отдаются; здесь — только что и как читать.
 *
 * Вид `feed` — лента по адресу (ADR-0132): GeoJSON, CSV или JSON по URL,
 * записи ложатся строками в существующий или новый датасет по ключу.
 */
export const SOURCE_KINDS = ['database', 'feed'] as const
export const SourceKind = z.enum(SOURCE_KINDS)
export type SourceKind = z.infer<typeof SourceKind>

/** Снимок — полная перезагрузка версии; инкремент — добор по полю-курсору. */
export const SOURCE_MODES = ['snapshot', 'incremental'] as const
export const SourceMode = z.enum(SOURCE_MODES)
export type SourceMode = z.infer<typeof SourceMode>

export const SOURCE_STATUSES = ['draft', 'queued', 'running', 'ok', 'error'] as const
export const SourceStatus = z.enum(SOURCE_STATUSES)
export type SourceStatus = z.infer<typeof SourceStatus>

/** Что читаем у внешней базы: таблицу целиком или заданный запрос. */
export const SourceQuery = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('table'),
    schema: z.string().trim().min(1).max(120),
    table: z.string().trim().min(1).max(200),
  }),
  z.object({ kind: z.literal('sql'), sql: z.string().trim().min(1).max(20_000) }),
])
export type SourceQuery = z.infer<typeof SourceQuery>

/** Столбец внешней выборки и поле датасета, в которое он ложится. */
export const SourceColumn = z.object({
  /** Имя столбца во внешней базе. */
  name: z.string().min(1).max(200),
  /** Тип, как его назвала внешняя база (для показа человеку). */
  nativeType: z.string().max(120),
  type: StoredFieldType,
  label: LangText.optional(),
  /** Ключ поля датасета; пусто — столбец не загружается. */
  key: z
    .string()
    .max(60)
    .regex(/^[a-z_][a-z0-9_]*$/, 'ключ поля: латиница, цифры и подчёркивание')
    .optional(),
})
export type SourceColumn = z.infer<typeof SourceColumn>

/** Ключ поля датасета: латиница, цифры и подчёркивание (как `FieldDef.key`). */
const DatasetFieldKey = z
  .string()
  .max(60)
  .regex(/^[a-z_][a-z0-9_]*$/, 'ключ поля: латиница, цифры и подчёркивание')

// ── Лента по адресу (ADR-0132) ────────────────────────────────────────────────

export const FEED_FORMATS = ['geojson', 'csv', 'json'] as const
export const FeedFormat = z.enum(FEED_FORMATS)
export type FeedFormat = z.infer<typeof FeedFormat>

/** Больше записей за опрос лента не переносит — сузьте область или адрес. */
export const FEED_MAX_ITEMS = 10_000
/** Ответ ленты больше этого не читается, байт. */
export const FEED_MAX_BYTES = 20 * 1024 * 1024
/** Сколько ждём ответа ленты, мс. */
export const FEED_TIMEOUT_MS = 30_000
/** Столько записей показывает предпросмотр ленты. */
export const FEED_PREVIEW_ITEMS = 20

/**
 * Путь к значению в записи ленты: ключи через точку, элементы массива — номером
 * (`properties.mag`, `geometry.coordinates.1`, `affectedcountries.0.iso3`); у CSV —
 * имя столбца.
 */
export const FeedPath = z.string().trim().min(1).max(300)

/**
 * Приведение значения: `auto` — по типу поля датасета (время — из ISO или числа
 * эпохи, без пояса — всемирное), `epoch_ms`/`epoch_s` — время из числа эпохи явно.
 */
export const FEED_TRANSFORMS = ['auto', 'text', 'number', 'epoch_ms', 'epoch_s'] as const
export const FeedTransform = z.enum(FEED_TRANSFORMS)
export type FeedTransform = z.infer<typeof FeedTransform>

/** Откуда берётся значение поля датасета. */
/**
 * Словарь значений ленты: код ленты → значение поля датасета (`EQ` → `earthquake`,
 * `Orange` → `orange`). Ищется точное совпадение, затем без учёта регистра, затем
 * запасной ключ `*`; не нашлось и запасного нет — значение остаётся как было.
 */
export const FeedValueMap = z
  .record(z.string().max(100), z.union([z.string().max(500), z.number(), z.boolean()]))
  .refine((map) => Object.keys(map).length <= 200, { message: 'не больше 200 значений' })
export type FeedValueMap = z.infer<typeof FeedValueMap>

export const FeedValue = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('path'),
    path: FeedPath,
    transform: FeedTransform.default('auto'),
    map: FeedValueMap.optional(),
  }),
  /** Постоянное значение: например, имя ленты в общем датасете нескольких лент. */
  z.object({
    kind: z.literal('const'),
    value: z.union([z.string().max(500), z.number(), z.boolean()]),
  }),
  /**
   * Шаблон из полей записи: `{latitude}_{longitude}_{acq_date}` — ключ записи у
   * ленты без идентификатора (NASA FIRMS).
   */
  z.object({ kind: z.literal('template'), template: z.string().trim().min(1).max(500) }),
  /** Дата и время в двух полях, всемирное время: `2026-09-23` + `0517` (NASA FIRMS). */
  z.object({ kind: z.literal('date_time'), date: FeedPath, time: FeedPath }),
])
export type FeedValue = z.infer<typeof FeedValue>

/** Поле датасета и его значение из записи ленты. */
export const FeedMapping = z.object({ field: DatasetFieldKey, value: FeedValue })
export type FeedMapping = z.infer<typeof FeedMapping>

/** Геометрия записи: объект GeoJSON или точка из широты и долготы. */
export const FeedGeometry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('feature') }),
  z.object({ kind: z.literal('latlon'), lat: FeedPath, lon: FeedPath }),
])
export type FeedGeometry = z.infer<typeof FeedGeometry>

/** Область отбора записей: запад, юг, восток, север в градусах WGS 84. */
export const FeedBbox = z
  .tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ])
  .refine(([west, south, east, north]) => west < east && south < north, {
    message: 'область: запад меньше востока, юг меньше севера',
  })
export type FeedBbox = z.infer<typeof FeedBbox>

/** Имя заголовка HTTP в запросе ленты. */
const HeaderName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'имя заголовка')

/** Адрес ленты: http или https. */
const FeedUrl = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .regex(/^https?:\/\//i, 'адрес ленты: http или https')

/**
 * Настройка ленты. Адрес и заголовки могут ссылаться на секреты интеграции вида
 * `http` (`{secret:mapKey}`): сервер подставляет их при запросе, в настройке и
 * ответах API их нет.
 */
export const FeedConfig = z.object({
  url: FeedUrl,
  headers: z.record(HeaderName, z.string().max(2000)).default({}),
  format: FeedFormat,
  /** Путь к массиву записей в JSON; пусто — массив в корне. */
  itemsPath: FeedPath.nullable().default(null),
  bbox: FeedBbox.nullable().default(null),
  /** Оставлять только записи, лежащие внутри справочника территорий (страны). */
  withinTerritory: z.boolean().default(false),
  mapping: z.array(FeedMapping).min(1).max(100),
  geometry: FeedGeometry.nullable().default(null),
  /** Поле датасета типа «геометрия» для геометрии записи. */
  geometryField: DatasetFieldKey.nullable().default(null),
  /** Поле датасета типа «территория», заполняемое районом, в котором лежит запись. */
  territoryField: DatasetFieldKey.nullable().default(null),
  /** Ключ записи: по нему повторный опрос обновляет строку, а не добавляет новую. */
  keyFields: z.array(DatasetFieldKey).min(1).max(5),
  maxItems: z.number().int().min(1).max(FEED_MAX_ITEMS).default(2000),
})
export type FeedConfig = z.infer<typeof FeedConfig>
export type FeedConfigInput = z.input<typeof FeedConfig>

/** Датасет-приёмник ленты: существующий (несколько лент в одном) или новый. */
export const FeedTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), datasetId: Uuid }),
  z.object({
    kind: z.literal('new'),
    name: z.string().trim().min(1).max(200),
    fields: z.array(DatasetFieldInput).min(1).max(100),
  }),
])
export type FeedTarget = z.infer<typeof FeedTarget>

/** Больше строк один прогон не переносит: защита от случайной выгрузки склада. */
export const SOURCE_MAX_ROWS = 5_000_000
/** Столько строк показывает предпросмотр внешней выборки. */
export const SOURCE_PREVIEW_ROWS = 50
/** Сколько ждём внешнюю базу при проверке связи и предпросмотре, мс. */
export const SOURCE_PROBE_TIMEOUT_MS = 10_000

export const SourceRecord = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  spaceId: Uuid,
  parentId: Uuid.nullable(),
  kind: SourceKind,
  /**
   * Интеграция с подключением (`postgres`/`mysql`); у ленты — необязательная
   * интеграция `http` с секретами адреса и заголовков.
   */
  integrationId: Uuid.nullable(),
  integrationName: z.string().nullable(),
  integrationKind: z.string().nullable(),
  /** Выборка внешней базы; у ленты — null. */
  query: SourceQuery.nullable(),
  /** Настройка ленты; у внешней базы — null. */
  feed: FeedConfig.nullable(),
  mode: SourceMode,
  /** Поле-курсор инкремента во внешней выборке. */
  cursorField: z.string().nullable(),
  /** Последнее перенесённое значение курсора (текстом). */
  cursorValue: z.string().nullable(),
  /** Ключ датасета для инкремента: по нему строки обновляются. */
  keyFields: z.array(z.string()),
  columns: z.array(SourceColumn),
  datasetId: Uuid.nullable(),
  schedule: z.string().nullable(),
  enabled: z.boolean(),
  status: SourceStatus,
  statusMessage: z.string().nullable(),
  lastCheckAt: Timestamp.nullable(),
  lastRunAt: Timestamp.nullable(),
  rowCount: z.number().int().nonnegative().nullable(),
  jobId: Uuid.nullable(),
  canManage: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type SourceRecord = z.infer<typeof SourceRecord>

export const SourceListItem = SourceRecord.pick({
  id: true,
  name: true,
  spaceId: true,
  kind: true,
  mode: true,
  status: true,
  schedule: true,
  enabled: true,
  datasetId: true,
  rowCount: true,
  lastRunAt: true,
})
export type SourceListItem = z.infer<typeof SourceListItem>

export const SourceList = z.object({ items: z.array(SourceListItem) })
export type SourceList = z.infer<typeof SourceList>

const sourceShape = {
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  integrationId: Uuid,
  query: SourceQuery,
  mode: SourceMode.default('snapshot'),
  cursorField: z.string().trim().max(200).nullable().optional(),
  keyFields: z.array(z.string().min(1).max(60)).max(10).default([]),
  columns: z.array(SourceColumn).min(1).max(300),
  schedule: z.string().trim().max(120).nullable().optional(),
  enabled: z.boolean().default(true),
}

export const SourceCreateInput = z.object({
  ...sourceShape,
  spaceId: Uuid,
  parentId: Uuid.nullable().optional(),
  /** Название датасета-результата; по умолчанию — название источника. */
  datasetName: z.string().trim().min(1).max(200).optional(),
})
export type SourceCreateInput = z.infer<typeof SourceCreateInput>

export const SourceUpdateInput = z.object({
  /** Настройка ленты целиком — только у источника вида `feed`. */
  feed: FeedConfig.optional(),
  /** Интеграция с секретами ленты — только у источника вида `feed`. */
  integrationId: Uuid.nullable().optional(),
  name: sourceShape.name.optional(),
  description: sourceShape.description,
  query: SourceQuery.optional(),
  mode: SourceMode.optional(),
  cursorField: sourceShape.cursorField,
  keyFields: z.array(z.string().min(1).max(60)).max(10).optional(),
  columns: z.array(SourceColumn).min(1).max(300).optional(),
  schedule: sourceShape.schedule,
  enabled: z.boolean().optional(),
})
export type SourceUpdateInput = z.infer<typeof SourceUpdateInput>

/** Лента по адресу: адрес и разбор, датасет-приёмник, расписание (ADR-0132). */
export const FeedSourceCreateInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  spaceId: Uuid,
  parentId: Uuid.nullable().optional(),
  integrationId: Uuid.nullable().default(null),
  feed: FeedConfig,
  target: FeedTarget,
  schedule: z.string().trim().max(120).nullable().optional(),
  enabled: z.boolean().default(true),
})
export type FeedSourceCreateInput = z.infer<typeof FeedSourceCreateInput>

/** Предпросмотр ленты: запрос по адресу без сохранения источника. */
export const FeedPreviewInput = z.object({
  url: FeedUrl,
  headers: z.record(HeaderName, z.string().max(2000)).default({}),
  format: FeedFormat,
  itemsPath: FeedPath.nullable().default(null),
  integrationId: Uuid.nullable().default(null),
  limit: z.number().int().min(1).max(FEED_PREVIEW_ITEMS).default(FEED_PREVIEW_ITEMS),
})
export type FeedPreviewInput = z.infer<typeof FeedPreviewInput>

export const FEED_VALUE_TYPES = [
  'text',
  'number',
  'boolean',
  'datetime',
  'geometry',
  'object',
] as const
export const FeedValueType = z.enum(FEED_VALUE_TYPES)
export type FeedValueType = z.infer<typeof FeedValueType>

/** Путь, найденный в записях ленты: тип по значениям, пример и сколько записей его заполняют. */
export const FeedPathInfo = z.object({
  path: z.string(),
  type: FeedValueType,
  sample: z.unknown(),
  filled: z.number().int().nonnegative(),
})
export type FeedPathInfo = z.infer<typeof FeedPathInfo>

export const FeedPreview = z.object({
  /** Сколько записей в ответе ленты всего. */
  total: z.number().int().nonnegative(),
  /** Первые записи — развёрнутые в пары «путь → значение». */
  items: z.array(z.record(z.string(), z.unknown())),
  paths: z.array(FeedPathInfo),
})
export type FeedPreview = z.infer<typeof FeedPreview>

/** Предпросмотр внешней выборки: столбцы с типами и несколько строк. */
export const SourcePreviewInput = z.object({
  integrationId: Uuid,
  query: SourceQuery,
  limit: z.number().int().min(1).max(SOURCE_PREVIEW_ROWS).default(20),
})
export type SourcePreviewInput = z.infer<typeof SourcePreviewInput>

export const SourcePreview = z.object({
  columns: z.array(SourceColumn),
  rows: z.array(z.array(z.unknown())),
})
export type SourcePreview = z.infer<typeof SourcePreview>

/** Список таблиц внешней базы для выбора без ручного ввода. */
export const SourceTable = z.object({
  schema: z.string(),
  table: z.string(),
  rows: z.number().int().nonnegative().nullable(),
})
export type SourceTable = z.infer<typeof SourceTable>

export const SourceTableList = z.object({ items: z.array(SourceTable) })
export type SourceTableList = z.infer<typeof SourceTableList>

export const SourceRunRecord = z.object({
  id: Uuid,
  sourceId: Uuid,
  jobId: Uuid.nullable(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  mode: SourceMode,
  stats: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
})
export type SourceRunRecord = z.infer<typeof SourceRunRecord>

export const SourceRunList = z.object({ items: z.array(SourceRunRecord) })
export type SourceRunList = z.infer<typeof SourceRunList>

export const SourceRunStarted = z.object({ jobId: Uuid, runId: Uuid })
export type SourceRunStarted = z.infer<typeof SourceRunStarted>

/** Результат задания синхронизации (`JobRecord.result`). */
export const SourceRunResult = z.object({
  datasetId: Uuid,
  rows: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
})
export type SourceRunResult = z.infer<typeof SourceRunResult>
