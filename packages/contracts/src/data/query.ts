import { z } from 'zod'
import { FilterNode } from '../common/filter.js'
import { LangText, Uuid } from '../common/primitives.js'
import { FieldFormat, FieldSemantic, FieldType } from '../fields/field-def.js'
import { QueryExecutor, QueryExecutorChoice } from './columnar.js'

/**
 * QuerySpec v1 — contracts/query-spec.md. Декларативный запрос: источник и
 * упорядоченные шаги. Один компилятор (`packages/query`) обслуживает таблицу
 * датасета, исследование, графики, показатели, экспорт и API.
 */

/** Алиас источника: латиница, цифры, подчёркивание. */
export const QueryAlias = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z_][a-z0-9_]*$/i, 'алиас: латиница, цифры, подчёркивание')

/** Ссылка на поле: `alias.field`, `field` или имя результата предыдущего шага. */
export const FieldRef = z.string().min(1).max(160)

/** Выражение на языке выражений платформы (contracts/query-spec.md §Язык выражений). */
export const Expression = z.string().min(1).max(4000)

/**
 * Системные датасеты — представления модулей в схеме `ds` с правами смотрящего
 * (ADR-0060); `territories` — справочник территорий с границами (ADR-0069);
 * `instructions` — поручения с состоянием контроля исполнения (ADR-0082).
 */
export const SYSTEM_DATASETS = [
  'tasks',
  'instructions',
  'documents',
  'meetings',
  'events',
  'territories',
] as const

/**
 * Схема системного датасета для смотрящего (`GET /system-datasets/{name}`):
 * поля без служебных и скрытых — подписи разрезов, условий и поля времени
 * показателя над системным датасетом (ADR-0082).
 */
export const SystemDatasetSchema = z.object({
  name: z.enum(SYSTEM_DATASETS),
  timeField: z.string().nullable(),
  fields: z.array(
    z.object({
      key: z.string(),
      label: LangText,
      type: FieldType,
      semantic: FieldSemantic.nullable(),
    }),
  ),
})
export type SystemDatasetSchema = z.infer<typeof SystemDatasetSchema>

export const QuerySource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dataset'), id: Uuid, alias: QueryAlias.optional() }),
  /** Сохранённый запрос как подзапрос. */
  z.object({ kind: z.literal('query'), id: Uuid, alias: QueryAlias.optional() }),
  z.object({
    kind: z.literal('system'),
    name: z.enum(SYSTEM_DATASETS),
    alias: QueryAlias.optional(),
  }),
  /** Небольшие константы. */
  z.object({
    kind: z.literal('inline'),
    rows: z.array(z.record(z.string(), z.unknown())).max(1000),
    alias: QueryAlias.optional(),
  }),
  /** Только режим SQL и доверенные объекты: проходит парсер и переписывание. */
  z.object({
    kind: z.literal('sql'),
    sql: z.string().min(1).max(100_000),
    alias: QueryAlias.optional(),
  }),
])
export type QuerySource = z.infer<typeof QuerySource>

export const TIME_BUCKETS = ['year', 'quarter', 'month', 'week', 'day', 'hour'] as const
export const TimeBucket = z.enum(TIME_BUCKETS)
export type TimeBucket = z.infer<typeof TimeBucket>

export const AGGREGATES = [
  'count',
  'count_distinct',
  'sum',
  'avg',
  'min',
  'max',
  'median',
  'p90',
  'p95',
  'first',
  'last',
  'expr',
  'string_agg',
] as const
export const Aggregate = z.enum(AGGREGATES)
export type Aggregate = z.infer<typeof Aggregate>

export const WINDOW_FUNCTIONS = [
  'lag',
  'lead',
  'running_sum',
  'rank',
  'dense_rank',
  'row_number',
  'moving_avg',
] as const
export const WindowFunction = z.enum(WINDOW_FUNCTIONS)
export type WindowFunction = z.infer<typeof WindowFunction>

export const SPATIAL_OPS = [
  'buffer',
  'intersects',
  'within',
  'dwithin',
  'nearest',
  'centroid',
  'area',
  'length',
  'assign_territory',
  'spatial_join',
  'grid',
  'hexgrid',
  'dissolve',
  'clip',
] as const
export type SpatialOp = (typeof SPATIAL_OPS)[number]

const FilterStep = z.object({ type: z.literal('filter'), where: FilterNode })

const JoinStep = z.object({
  type: z.literal('join'),
  source: QuerySource,
  on: z.array(z.object({ left: FieldRef, right: FieldRef })).min(1),
  kind: z.enum(['inner', 'left', 'right', 'full']).default('left'),
  /** Использовать объявленную связь датасетов. */
  relationId: Uuid.optional(),
})

const ComputeStep = z.object({
  type: z.literal('compute'),
  fields: z
    .array(z.object({ name: QueryAlias, expr: Expression, type: FieldType.optional() }))
    .min(1),
})

const AggregateStep = z.object({
  type: z.literal('aggregate'),
  groupBy: z
    .array(
      z.object({ field: FieldRef, bucket: TimeBucket.optional(), alias: QueryAlias.optional() }),
    )
    .default([]),
  measures: z
    .array(
      z.object({
        alias: QueryAlias,
        agg: Aggregate,
        field: FieldRef.optional(),
        expr: Expression.optional(),
        /** Условная мера: агрегат только по строкам, прошедшим фильтр. */
        filter: FilterNode.optional(),
      }),
    )
    .default([]),
})

const WindowStep = z.object({
  type: z.literal('window'),
  fields: z
    .array(
      z.object({
        alias: QueryAlias,
        fn: WindowFunction,
        field: FieldRef.optional(),
        partitionBy: z.array(FieldRef).default([]),
        orderBy: z.array(FieldRef).default([]),
        n: z.number().int().min(1).max(1000).optional(),
      }),
    )
    .min(1),
})

export const QuerySortItem = z.object({
  field: FieldRef,
  dir: z.enum(['asc', 'desc']).default('asc'),
  nulls: z.enum(['first', 'last']).optional(),
})

const SortStep = z.object({ type: z.literal('sort'), by: z.array(QuerySortItem).min(1) })

const LimitStep = z.object({
  type: z.literal('limit'),
  limit: z.number().int().min(0).max(1_000_000),
  offset: z.number().int().min(0).default(0),
})

const SelectStep = z.object({
  type: z.literal('select'),
  fields: z.array(z.union([FieldRef, z.object({ field: FieldRef, alias: QueryAlias })])).min(1),
})

const PivotStep = z.object({
  type: z.literal('pivot'),
  rows: z.array(FieldRef).min(1),
  columns: FieldRef,
  measure: z.object({ agg: Aggregate, field: FieldRef.optional(), alias: QueryAlias.optional() }),
})

const UnionStep = z.object({
  type: z.literal('union'),
  source: QuerySource,
  mode: z.enum(['all', 'distinct']).default('all'),
})

/**
 * Пространственная операция (07-gis-engine.md §10, ADR-0069): параметры и цель
 * проверяет компилятор — у каждой операции свой набор (contracts/query-spec.md).
 */
const SpatialStep = z.object({
  type: z.literal('spatial'),
  op: z.enum(SPATIAL_OPS),
  params: z.record(z.string(), z.unknown()).default({}),
  target: z.unknown().optional(),
})

const UnnestStep = z.object({ type: z.literal('unnest'), field: FieldRef })

/**
 * Столбцы → строки (ADR-0106): выбранные поля превращаются в пары «имя,
 * значение», остальные (`keep`) повторяются в каждой строке. Значения
 * приводятся к общему типу — иначе результат нельзя было бы сложить в один
 * столбец.
 */
const UnpivotStep = z.object({
  type: z.literal('unpivot'),
  keep: z.array(FieldRef).max(50).default([]),
  fields: z.array(FieldRef).min(1).max(200),
  nameField: QueryAlias.default('name'),
  valueField: QueryAlias.default('value'),
  /** Не создавать строку для пустого значения. */
  dropNulls: z.boolean().default(true),
})

const SampleStep = z
  .object({
    type: z.literal('sample'),
    n: z.number().int().min(1).max(100_000).optional(),
    fraction: z.number().gt(0).max(1).optional(),
  })
  .refine((step) => step.n !== undefined || step.fraction !== undefined, {
    message: 'Нужно n или fraction',
  })

export const QueryStep = z.union([
  FilterStep,
  JoinStep,
  ComputeStep,
  AggregateStep,
  WindowStep,
  SortStep,
  LimitStep,
  SelectStep,
  PivotStep,
  UnionStep,
  SpatialStep,
  UnnestStep,
  UnpivotStep,
  SampleStep,
])
export type QueryStep = z.infer<typeof QueryStep>

export const QueryParam = z.object({
  type: z.enum([
    'text',
    'number',
    'date',
    'datetime',
    'boolean',
    'territory',
    'unit',
    'user',
    'list',
  ]),
  default: z.unknown().optional(),
  label: LangText.optional(),
  required: z.boolean().default(false),
})
export type QueryParam = z.infer<typeof QueryParam>

export const QueryOptions = z.object({
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
  cache: z.boolean().default(true),
  approxCount: z.boolean().default(true),
  /**
   * Исполнитель запроса (ADR-0109): `auto` — по размеру датасета и виду
   * запроса, `postgres` — всегда основное хранилище, `columnar` — колоночная
   * копия, когда она годится. По умолчанию — `auto`.
   */
  executor: QueryExecutorChoice.optional(),
})

export const QuerySpec = z.object({
  version: z.literal(1),
  source: QuerySource,
  steps: z.array(QueryStep).max(100).default([]),
  params: z.record(z.string(), QueryParam).default({}),
  options: QueryOptions.default({ cache: true, approxCount: true }),
})
export type QuerySpec = z.infer<typeof QuerySpec>

// ─── Результат ───────────────────────────────────────────────────────────────

export const QueryResultField = z.object({
  name: z.string(),
  type: FieldType,
  semantic: FieldSemantic.nullable(),
  label: LangText.nullable(),
  format: FieldFormat.nullable(),
})
export type QueryResultField = z.infer<typeof QueryResultField>

export const QueryResult = z.object({
  fields: z.array(QueryResultField),
  /** Колоночный результат строками: значения в порядке `fields`. */
  rows: z.array(z.array(z.unknown())),
  /** Всего строк без limit (точно или оценкой — `approx`); null — не считалось. */
  rowCount: z.number().int().nonnegative().nullable(),
  approx: z.boolean(),
  /** Результат обрезан лимитом интерактивного режима. */
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
  cached: z.boolean(),
  /** Где считался запрос — показывается пользователю рядом с результатом. */
  executedOn: QueryExecutor.default('postgres'),
  /** Сгенерированный SQL — только со способностью data.sql. */
  sql: z.string().optional(),
})
export type QueryResult = z.infer<typeof QueryResult>

export const QueryRunInput = z.object({
  spec: QuerySpec,
  params: z.record(z.string(), z.unknown()).default({}),
})
export type QueryRunInput = z.infer<typeof QueryRunInput>

/** Ошибка компиляции с путём в спецификации и позицией в выражении. */
export const QueryIssue = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
  /** Позиция в выражении (0-based), если ошибка в выражении. */
  position: z.number().int().nonnegative().optional(),
  hint: z.string().optional(),
})
export type QueryIssue = z.infer<typeof QueryIssue>
