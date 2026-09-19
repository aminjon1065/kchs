import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  createdAt,
  jsonbArray,
  jsonbObject,
  type LangTextValue,
  tsCol,
  updatedAt,
} from './_shared.js'
import { users } from './identity.js'
import { objects } from './kernel.js'

/**
 * Данные и аналитика (05-data-model.md §Данные, 06-analytics-engine.md).
 * Метаданные — здесь, строки датасетов — в физических таблицах схемы `ds`
 * (их DDL ведёт `modules/data/infra/physical.ts`, не миграции).
 */

/** Датасет — объект реестра типа `dataset`. */
export const datasets = pgTable(
  'datasets',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('table'),
    /** Где лежат строки: `postgres` (фаза 1), позже — колоночный tier. */
    storage: text('storage').notNull().default('postgres'),
    sourceId: uuid('source_id'),
    primaryKey: text('primary_key').array().notNull().default(sql`'{}'::text[]`),
    geometry: jsonb('geometry').$type<{ field: string; type: string } | null>(),
    timeField: text('time_field'),
    territoryField: text('territory_field'),
    rowCount: bigint('row_count', { mode: 'number' }).notNull().default(0),
    currentVersion: integer('current_version').notNull().default(0),
    settings: jsonbObject<{ editable?: boolean; trackHistory?: boolean }>('settings'),
    description: text('description'),
    stewardId: uuid('steward_id').references(() => users.id, { onDelete: 'set null' }),
    /** Физическая таблица `ds.t_<sid>`; стабильна — переименование датасета её не трогает. */
    physicalTable: text('physical_table').notNull(),
    lastImportAt: tsCol('last_import_at'),
    schemaVersion: integer('schema_version').notNull().default(1),
    /** Счётчик физических столбцов: имя столбца поля — `c_<n>`, не зависит от ключа. */
    nextColumn: integer('next_column').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('datasets_physical_table_uq').on(t.physicalTable)],
)

/** Поле датасета: определение (FieldDef) и физический столбец. */
export const datasetFields = pgTable(
  'dataset_fields',
  {
    id: uuid('id').primaryKey(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: jsonb('label').$type<LangTextValue>().notNull(),
    type: text('type').notNull(),
    semantic: text('semantic').notNull().default('dimension'),
    format: jsonb('format').$type<Record<string, unknown> | null>(),
    unit: text('unit'),
    nullable: boolean('nullable').notNull().default(true),
    required: boolean('required').notNull().default(false),
    unique: boolean('unique').notNull().default(false),
    indexed: boolean('indexed').notNull().default(false),
    sensitive: boolean('sensitive').notNull().default(false),
    lookup: jsonb('lookup').$type<Record<string, unknown> | null>(),
    formula: text('formula'),
    description: text('description'),
    order: integer('order').notNull().default(0),
    /** Остальная часть определения поля (варианты, проверки, условия видимости). */
    definition: jsonbObject('definition'),
    physicalColumn: text('physical_column'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('dataset_fields_key_uq').on(t.datasetId, t.key)],
)

/** Версии датасета: каждая загрузка, правка схемы и откат. */
export const datasetVersions = pgTable(
  'dataset_versions',
  {
    id: uuid('id').primaryKey(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    origin: text('origin').notNull(),
    rowCount: bigint('row_count', { mode: 'number' }).notNull().default(0),
    diff: jsonbObject<{ added: number; updated: number; deleted: number }>('diff'),
    importId: uuid('import_id'),
    parquetKey: text('parquet_key'),
    schemaSnapshot: jsonb('schema_snapshot').$type<unknown[] | null>(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('dataset_versions_number_uq').on(t.datasetId, t.number)],
)

/** Связи датасетов: ключ → ключ (P1-E07). */
export const datasetRelations = pgTable(
  'dataset_relations',
  {
    id: uuid('id').primaryKey(),
    leftDatasetId: uuid('left_dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    leftField: text('left_field').notNull(),
    rightDatasetId: uuid('right_dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    rightField: text('right_field').notNull(),
    cardinality: text('cardinality').notNull().default('many_to_one'),
    label: jsonb('label').$type<LangTextValue | null>(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('dataset_relations_left_idx').on(t.leftDatasetId)],
)

/** Политика строк: фильтр над полями и атрибутами пользователя (03-access-model.md). */
export const datasetRowPolicies = pgTable(
  'dataset_row_policies',
  {
    id: uuid('id').primaryKey(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    principalType: text('principal_type').notNull(),
    principalId: text('principal_id').notNull(),
    filter: jsonb('filter').$type<Record<string, unknown>>().notNull(),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('dataset_row_policies_dataset_idx').on(t.datasetId)],
)

/** Политика столбцов: скрыть или замаскировать поля для принципала. */
export const datasetColumnPolicies = pgTable(
  'dataset_column_policies',
  {
    id: uuid('id').primaryKey(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    principalType: text('principal_type').notNull(),
    principalId: text('principal_id').notNull(),
    mode: text('mode').notNull(),
    fields: text('fields').array().notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('dataset_column_policies_dataset_idx').on(t.datasetId)],
)

/** Импорт файла в датасет (ADR-0046): анализ → нормализация в движке → загрузка воркером. */
export const imports = pgTable(
  'imports',
  {
    id: uuid('id').primaryKey(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id').notNull(),
    status: text('status').notNull().default('queued'),
    mode: text('mode').notNull().default('replace'),
    options: jsonbObject('options'),
    mapping: jsonbArray<Record<string, unknown>>('mapping'),
    key: text('key').array().notNull().default(sql`'{}'::text[]`),
    onError: text('on_error').notNull().default('skip'),
    /** Как собирается геометрия (ImportGeometry) и в какое поле; без неё — null. */
    geometry: jsonb('geometry').$type<Record<string, unknown>>(),
    geometryField: text('geometry_field'),
    stats: jsonbObject<Record<string, number>>('stats'),
    errorSample: jsonbArray<Record<string, unknown>>('error_sample'),
    normalizedKey: text('normalized_key'),
    errorsKey: text('errors_key'),
    errorsFileId: uuid('errors_file_id'),
    jobId: uuid('job_id'),
    version: integer('version'),
    message: text('message'),
    /** Предпросмотр изменений: после разбора импорт ждёт публикации (ADR-0068). */
    review: boolean('review').notNull().default(false),
    /** Сводка изменений по ключу (ImportDiff) — с состояния `review`. */
    diff: jsonb('diff').$type<Record<string, unknown>>(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    finishedAt: tsCol('finished_at'),
  },
  (t) => [index('imports_dataset_idx').on(t.datasetId, t.createdAt)],
)

/** Сохранённый запрос — объект реестра типа `query`. */
export const queries = pgTable('queries', {
  id: uuid('id')
    .primaryKey()
    .references(() => objects.id, { onDelete: 'cascade' }),
  mode: text('mode').notNull().default('visual'),
  spec: jsonb('spec').$type<Record<string, unknown>>().notNull(),
  sql: text('sql'),
  paramsSchema: jsonbObject('params_schema'),
  datasetIds: uuid('dataset_ids').array().notNull().default(sql`'{}'::uuid[]`),
  compiledHash: text('compiled_hash'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/** Журнал выполнения запросов — для профилирования и «медленных запросов». */
export const queryRuns = pgTable(
  'query_runs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    queryId: uuid('query_id'),
    userId: uuid('user_id'),
    specHash: text('spec_hash').notNull(),
    durationMs: real('duration_ms').notNull(),
    rowCount: bigint('row_count', { mode: 'number' }),
    cached: boolean('cached').notNull().default(false),
    error: text('error'),
    at: createdAt(),
  },
  (t) => [index('query_runs_at_idx').on(t.at)],
)

/** Показатель — объект реестра типа `metric`. */
export const metrics = pgTable('metrics', {
  id: uuid('id')
    .primaryKey()
    .references(() => objects.id, { onDelete: 'cascade' }),
  datasetId: uuid('dataset_id').references(() => datasets.id, { onDelete: 'set null' }),
  definition: jsonbObject('definition'),
  unit: text('unit'),
  format: jsonb('format').$type<Record<string, unknown> | null>(),
  direction: text('direction').notNull().default('up'),
  targets: jsonbArray('targets'),
  thresholds: jsonbArray('thresholds'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/** График — объект реестра типа `chart`. */
export const charts = pgTable('charts', {
  id: uuid('id')
    .primaryKey()
    .references(() => objects.id, { onDelete: 'cascade' }),
  queryId: uuid('query_id').references(() => queries.id, { onDelete: 'set null' }),
  spec: jsonb('spec').$type<Record<string, unknown>>().notNull(),
  paramsDefaults: jsonbObject('params_defaults'),
  datasetIds: uuid('dataset_ids').array().notNull().default(sql`'{}'::uuid[]`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/** Дашборд — объект реестра типа `dashboard`. */
export const dashboards = pgTable('dashboards', {
  id: uuid('id')
    .primaryKey()
    .references(() => objects.id, { onDelete: 'cascade' }),
  spec: jsonb('spec').$type<Record<string, unknown>>().notNull(),
  refreshInterval: integer('refresh_interval'),
  theme: text('theme').notNull().default('auto'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/**
 * Пространственный анализ — объект реестра типа `analysis` (07-gis-engine.md §10,
 * ADR-0069): воспроизводимые параметры (запрос с шагом `spatial`), источники,
 * датасет-результат и состояние последнего запуска.
 */
export const analyses = pgTable(
  'analyses',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    /** Операция последнего шага `spatial`. */
    kind: text('kind').notNull(),
    /** `{ query, outputName }` — всё, что нужно для повторного запуска. */
    params: jsonbObject('params'),
    inputDatasetIds: uuid('input_dataset_ids').array().notNull().default(sql`'{}'::uuid[]`),
    outputDatasetId: uuid('output_dataset_id').references(() => datasets.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('draft'),
    jobId: uuid('job_id'),
    rowCount: bigint('row_count', { mode: 'number' }),
    error: text('error'),
    lastRunAt: tsCol('last_run_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('analyses_output_idx').on(t.outputDatasetId),
    index('analyses_inputs_idx').using('gin', t.inputDatasetIds),
  ],
)
