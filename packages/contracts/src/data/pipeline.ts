import { z } from 'zod'
import { FilterNode } from '../common/filter.js'
import { Timestamp, Uuid } from '../common/primitives.js'
import { StoredFieldType } from './dataset.js'
import {
  Aggregate,
  Expression,
  FieldRef,
  QueryAlias,
  QuerySortItem,
  QuerySource,
  QuerySpec,
  TimeBucket,
} from './query.js'

/**
 * Пайплайн — объект реестра типа `pipeline` (06-analytics-engine.md §16,
 * 05-data-model.md §Данные, ADR-0106): цепочка шагов над входными датасетами,
 * которая заданием материализуется в новую версию выходного датасета. Шаги —
 * табличные операции; компилятор пайплайна переводит их в `QuerySpec`, так что
 * права, политики строк и столбцов и параметризация — общие с любым запросом.
 */
export const PIPELINE_STEP_TYPES = [
  'custom_sql',
  'select',
  'rename',
  'cast',
  'filter',
  'dedupe',
  'fill',
  'split',
  'merge_columns',
  'compute',
  'join',
  'union',
  'aggregate',
  'unpivot',
  'pivot',
  'geocode',
  'assign_territory',
  'spatial_join',
] as const
export const PipelineStepType = z.enum(PIPELINE_STEP_TYPES)
export type PipelineStepType = z.infer<typeof PipelineStepType>

/** Идентификатор шага в определении: по нему делается предпросмотр и адресуются ошибки. */
export const PipelineStepId = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'идентификатор шага: строчные латинские буквы, цифры и дефис')

const stepBase = {
  id: PipelineStepId,
  /** Выключенный шаг остаётся в определении, но не выполняется. */
  disabled: z.boolean().default(false),
  note: z.string().trim().max(500).optional(),
}

/**
 * Сырой SQL как источник: разрешён только первым шагом и проходит тот же
 * разбор (`libpg-query`), переписывание с политиками и ограниченную роль
 * `kchs_query`, что и SQL-лаборатория. Требует способности `data.sql`.
 */
const CustomSqlStep = z.object({
  ...stepBase,
  type: z.literal('custom_sql'),
  sql: z.string().min(1).max(100_000),
})

const SelectStep = z.object({
  ...stepBase,
  type: z.literal('select'),
  fields: z
    .array(z.object({ field: FieldRef, as: QueryAlias.optional() }))
    .min(1)
    .max(300),
})

const RenameStep = z.object({
  ...stepBase,
  type: z.literal('rename'),
  renames: z
    .array(z.object({ field: FieldRef, to: QueryAlias }))
    .min(1)
    .max(300),
})

const CastStep = z.object({
  ...stepBase,
  type: z.literal('cast'),
  casts: z
    .array(z.object({ field: FieldRef, to: StoredFieldType }))
    .min(1)
    .max(100),
})

const FilterStep = z.object({ ...stepBase, type: z.literal('filter'), where: FilterNode })

/**
 * Дубликаты по ключу: остаётся первая или последняя строка в заданном порядке.
 * Компилируется в сводку с мерами `first`/`last` по остальным полям.
 */
const DedupeStep = z.object({
  ...stepBase,
  type: z.literal('dedupe'),
  by: z.array(FieldRef).min(1).max(20),
  keep: z.enum(['first', 'last']).default('first'),
  orderBy: z.array(QuerySortItem).max(10).default([]),
})

/** Заполнение пустых значений: постоянным значением или значением другого поля. */
const FillStep = z.object({
  ...stepBase,
  type: z.literal('fill'),
  field: FieldRef,
  with: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('value'), value: z.union([z.string(), z.number(), z.boolean()]) }),
    z.object({ kind: z.literal('field'), field: FieldRef }),
  ]),
})

const SplitStep = z.object({
  ...stepBase,
  type: z.literal('split'),
  field: FieldRef,
  separator: z.string().min(1).max(8),
  into: z.array(QueryAlias).min(1).max(20),
  /** Убрать исходное поле из результата. */
  drop: z.boolean().default(false),
})

const MergeColumnsStep = z.object({
  ...stepBase,
  type: z.literal('merge_columns'),
  fields: z.array(FieldRef).min(2).max(20),
  into: QueryAlias,
  separator: z.string().max(8).default(' '),
  drop: z.boolean().default(false),
})

const ComputeStep = z.object({
  ...stepBase,
  type: z.literal('compute'),
  fields: z
    .array(z.object({ name: QueryAlias, expr: Expression, type: StoredFieldType.optional() }))
    .min(1)
    .max(50),
})

const JoinStep = z.object({
  ...stepBase,
  type: z.literal('join'),
  source: QuerySource,
  on: z
    .array(z.object({ left: FieldRef, right: FieldRef }))
    .min(1)
    .max(10),
  kind: z.enum(['inner', 'left', 'right', 'full']).default('left'),
})

const UnionStep = z.object({
  ...stepBase,
  type: z.literal('union'),
  source: QuerySource,
  mode: z.enum(['all', 'distinct']).default('all'),
})

const AggregateStep = z.object({
  ...stepBase,
  type: z.literal('aggregate'),
  groupBy: z
    .array(
      z.object({ field: FieldRef, bucket: TimeBucket.optional(), alias: QueryAlias.optional() }),
    )
    .max(20)
    .default([]),
  measures: z
    .array(
      z.object({
        alias: QueryAlias,
        agg: Aggregate,
        field: FieldRef.optional(),
        expr: Expression.optional(),
        filter: FilterNode.optional(),
      }),
    )
    .max(50)
    .default([]),
})

/** Столбцы → строки: каждое выбранное поле даёт строку «имя, значение». */
const UnpivotStep = z.object({
  ...stepBase,
  type: z.literal('unpivot'),
  /** Поля, которые остаются как есть (ключи). */
  keep: z.array(FieldRef).max(50).default([]),
  fields: z.array(FieldRef).min(1).max(200),
  nameField: QueryAlias.default('name'),
  valueField: QueryAlias.default('value'),
  /** Не создавать строку для пустого значения. */
  dropNulls: z.boolean().default(true),
})

/**
 * Строки → столбцы: по одному столбцу на перечисленное значение разреза.
 * Значения перечисляются явно — набор столбцов результата должен быть известен
 * до выполнения, иначе у выходного датасета менялась бы схема (ADR-0106).
 */
const PivotStep = z.object({
  ...stepBase,
  type: z.literal('pivot'),
  groupBy: z.array(FieldRef).min(1).max(10),
  column: FieldRef,
  values: z.array(z.string().min(1).max(120)).min(1).max(50),
  measure: z.object({ agg: Aggregate, field: FieldRef.optional() }),
})

/**
 * Геокодирование по справочнику территорий (ADR-0106): поле с кодом или
 * названием территории → идентификатор территории и точка её центра. Нечёткое
 * сопоставление адресов — позже (вопрос N53).
 */
const GeocodeStep = z.object({
  ...stepBase,
  type: z.literal('geocode'),
  field: FieldRef,
  match: z.enum(['code', 'name']).default('code'),
  /** Имя поля-территории в результате. */
  as: QueryAlias.default('territory_id'),
  /** Имя поля с точкой центра территории; пусто — точку не добавлять. */
  pointAs: QueryAlias.optional(),
})

const AssignTerritoryStep = z.object({
  ...stepBase,
  type: z.literal('assign_territory'),
  level: z.enum(['country', 'region', 'district', 'jamoat', 'settlement']),
  as: QueryAlias.optional(),
  /** Поле геометрии, если их несколько. */
  field: FieldRef.optional(),
})

const SpatialJoinStep = z.object({
  ...stepBase,
  type: z.literal('spatial_join'),
  /** Цель пространственного соединения (contracts/query-spec.md, шаг spatial). */
  target: z.unknown().optional(),
  predicate: z.enum(['intersects', 'contains', 'within', 'dwithin']).default('intersects'),
  distance: z.number().positive().max(1_000_000).optional(),
  measures: z
    .array(
      z.object({
        alias: QueryAlias,
        agg: z.enum(['count', 'count_distinct', 'sum', 'avg', 'min', 'max']),
        field: FieldRef.optional(),
      }),
    )
    .max(20)
    .default([]),
  field: FieldRef.optional(),
})

export const PipelineStep = z.discriminatedUnion('type', [
  CustomSqlStep,
  SelectStep,
  RenameStep,
  CastStep,
  FilterStep,
  DedupeStep,
  FillStep,
  SplitStep,
  MergeColumnsStep,
  ComputeStep,
  JoinStep,
  UnionStep,
  AggregateStep,
  UnpivotStep,
  PivotStep,
  GeocodeStep,
  AssignTerritoryStep,
  SpatialJoinStep,
])
export type PipelineStep = z.infer<typeof PipelineStep>

/** Больше строк пайплайн не материализует — прогон завершается ошибкой. */
export const PIPELINE_MAX_ROWS = 1_000_000
/** Строк предпросмотра шага. */
export const PIPELINE_PREVIEW_ROWS = 200
export const PIPELINE_MAX_STEPS = 40

export const PipelineDefinition = z.object({
  version: z.literal(1),
  /** Входной датасет; сырой SQL задаётся первым шагом `custom_sql`. */
  source: QuerySource,
  steps: z.array(PipelineStep).max(PIPELINE_MAX_STEPS).default([]),
  /** Название датасета-результата при первом прогоне. */
  outputName: z.string().trim().min(1).max(200),
})
export type PipelineDefinition = z.infer<typeof PipelineDefinition>

export const PIPELINE_STATUSES = ['draft', 'queued', 'running', 'succeeded', 'failed'] as const
export const PipelineStatus = z.enum(PIPELINE_STATUSES)
export type PipelineStatus = z.infer<typeof PipelineStatus>

export const PIPELINE_TRIGGERS = ['manual', 'schedule', 'import', 'rule'] as const
export const PipelineTrigger = z.enum(PIPELINE_TRIGGERS)
export type PipelineTrigger = z.infer<typeof PipelineTrigger>

export const PipelineRecord = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  spaceId: Uuid,
  parentId: Uuid.nullable(),
  definition: PipelineDefinition,
  /** Расписание cron (5 полей) или null. */
  schedule: z.string().nullable(),
  enabled: z.boolean(),
  /** Запускать после успешного импорта входного датасета (`dataset.imported`). */
  runOnImport: z.boolean(),
  inputDatasetIds: z.array(Uuid),
  outputDatasetId: Uuid.nullable(),
  status: PipelineStatus,
  jobId: Uuid.nullable(),
  rowCount: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
  lastRunAt: Timestamp.nullable(),
  canManage: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type PipelineRecord = z.infer<typeof PipelineRecord>

export const PipelineListItem = PipelineRecord.pick({
  id: true,
  name: true,
  spaceId: true,
  status: true,
  schedule: true,
  enabled: true,
  outputDatasetId: true,
  rowCount: true,
  lastRunAt: true,
})
export type PipelineListItem = z.infer<typeof PipelineListItem>

export const PipelineList = z.object({ items: z.array(PipelineListItem) })
export type PipelineList = z.infer<typeof PipelineList>

export const PipelineCreateInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  spaceId: Uuid,
  parentId: Uuid.nullable().optional(),
  definition: PipelineDefinition,
  schedule: z.string().trim().max(120).nullable().optional(),
  runOnImport: z.boolean().default(false),
  enabled: z.boolean().default(true),
})
export type PipelineCreateInput = z.infer<typeof PipelineCreateInput>

export const PipelineUpdateInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  definition: PipelineDefinition.optional(),
  schedule: z.string().trim().max(120).nullable().optional(),
  runOnImport: z.boolean().optional(),
  enabled: z.boolean().optional(),
})
export type PipelineUpdateInput = z.infer<typeof PipelineUpdateInput>

/**
 * Предпросмотр: результат определения, обрезанного по шаг `untilStepId`
 * включительно, на выборке строк с правами и политиками смотрящего.
 */
export const PipelinePreviewInput = z.object({
  definition: PipelineDefinition,
  untilStepId: PipelineStepId.optional(),
  limit: z.number().int().min(1).max(PIPELINE_PREVIEW_ROWS).default(50),
})
export type PipelinePreviewInput = z.infer<typeof PipelinePreviewInput>

/** Скомпилированный запрос пайплайна — для проверки определения в конструкторе. */
export const PipelineValidateInput = z.object({ definition: PipelineDefinition })
export type PipelineValidateInput = z.infer<typeof PipelineValidateInput>

export const PipelineValidateResult = z.object({
  ok: z.boolean(),
  /** Поля результата последнего шага (при `ok`). */
  fields: z.array(z.object({ name: z.string(), type: z.string() })),
  /** Шаг, на котором определение сломалось. */
  stepId: PipelineStepId.nullable(),
  message: z.string().nullable(),
  /** Итоговая спецификация запроса — подсказка для отладки. */
  spec: QuerySpec.nullable(),
})
export type PipelineValidateResult = z.infer<typeof PipelineValidateResult>

export const PipelineRunRecord = z.object({
  id: Uuid,
  pipelineId: Uuid,
  jobId: Uuid.nullable(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  trigger: PipelineTrigger,
  /** Строк записано, добавлено/изменено/удалено, номер версии результата. */
  stats: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  /** Отклонённые строки: причина и пример. */
  rejected: z.number().int().nonnegative(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
})
export type PipelineRunRecord = z.infer<typeof PipelineRunRecord>

export const PipelineRunList = z.object({ items: z.array(PipelineRunRecord) })
export type PipelineRunList = z.infer<typeof PipelineRunList>

export const PipelineRunStarted = z.object({ jobId: Uuid, runId: Uuid })
export type PipelineRunStarted = z.infer<typeof PipelineRunStarted>

/** Результат задания пайплайна (`JobRecord.result`). */
export const PipelineRunResult = z.object({
  datasetId: Uuid,
  rows: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  created: z.boolean(),
})
export type PipelineRunResult = z.infer<typeof PipelineRunResult>
