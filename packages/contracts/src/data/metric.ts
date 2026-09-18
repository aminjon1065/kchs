import { z } from 'zod'
import { FilterNode } from '../common/filter.js'
import { DateOnly, Timestamp, Uuid } from '../common/primitives.js'
import { FieldFormat } from '../fields/field-def.js'
import { Expression, FieldRef } from './query.js'

/**
 * Показатель (06-analytics-engine.md §7, ADR-0058) — именованная мера над
 * датасетом: агрегат, фильтры, поле времени, допустимые разрезы, единица и
 * формат, цели и пороги. Объект реестра типа `metric`. Значение считается одним
 * путём кода для плитки дашборда, карточки и API — с политиками смотрящего.
 */

/** Агрегаты меры показателя: числовые; `expr` — выражение с агрегатами. */
export const METRIC_AGGREGATES = [
  'count',
  'count_distinct',
  'sum',
  'avg',
  'min',
  'max',
  'median',
  'p90',
  'p95',
  'expr',
] as const
export const MetricAggregate = z.enum(METRIC_AGGREGATES)
export type MetricAggregate = z.infer<typeof MetricAggregate>

/** Мера: агрегат над полем (количество — и без поля) или выражение (`sum(a) / count()`). */
export const MetricMeasure = z
  .object({
    agg: MetricAggregate,
    field: FieldRef.optional(),
    expr: Expression.optional(),
  })
  .refine((measure) => (measure.agg === 'expr') === (measure.expr !== undefined), {
    message: 'Выражение задаётся только у меры «выражение»',
    path: ['expr'],
  })
  .refine((measure) => measure.agg !== 'expr' || measure.field === undefined, {
    message: 'У меры-выражения поле не указывается',
    path: ['field'],
  })
export type MetricMeasure = z.infer<typeof MetricMeasure>

/** Единицы периода — как у относительного фильтра (`relative`). */
export const METRIC_PERIOD_UNITS = ['day', 'week', 'month', 'quarter', 'year'] as const
export const MetricPeriodUnit = z.enum(METRIC_PERIOD_UNITS)
export type MetricPeriodUnit = z.infer<typeof MetricPeriodUnit>

/**
 * Относительный период — целые календарные единицы в поясе пользователя, как у
 * фильтра `relative`: `{unit: 'month', from: 0, to: 0}` — этот месяц,
 * `{unit: 'day', from: -29, to: 0}` — последние 30 дней.
 */
export const MetricRelativePeriod = z
  .object({
    unit: MetricPeriodUnit,
    from: z.number().int().min(-1000).max(0),
    to: z.number().int().min(-1000).max(0),
  })
  .refine((period) => period.from <= period.to, {
    message: 'Начало периода позже конца',
    path: ['from'],
  })

/** Даты включительно. */
export const MetricDatePeriod = z
  .object({ start: DateOnly, end: DateOnly })
  .refine((period) => period.start <= period.end, {
    message: 'Начало периода позже конца',
    path: ['start'],
  })

/** Период значения; null — всё время. */
export const MetricPeriod = z.union([MetricRelativePeriod, MetricDatePeriod])
export type MetricPeriod = z.infer<typeof MetricPeriod>

export const METRIC_COMPARISONS = ['none', 'previous_period', 'previous_year', 'target'] as const
export const MetricComparison = z.enum(METRIC_COMPARISONS)
export type MetricComparison = z.infer<typeof MetricComparison>

/** Что считается улучшением: рост (`up`), снижение (`down`) или ни то ни другое. */
export const METRIC_DIRECTIONS = ['up', 'down', 'neutral'] as const
export const MetricDirection = z.enum(METRIC_DIRECTIONS)
export type MetricDirection = z.infer<typeof MetricDirection>

export const METRIC_STATUSES = ['success', 'warning', 'danger'] as const
export const MetricStatus = z.enum(METRIC_STATUSES)
export type MetricStatus = z.infer<typeof MetricStatus>

/** Порог: значение не ниже `value` получает статус (действует наибольший подходящий). */
export const MetricThreshold = z.object({ value: z.number(), status: MetricStatus })
export type MetricThreshold = z.infer<typeof MetricThreshold>

/** Цель на период единицы `unit` (null — на любой период). */
export const MetricTarget = z.object({
  value: z.number(),
  unit: MetricPeriodUnit.nullable().default(null),
})
export type MetricTarget = z.infer<typeof MetricTarget>

export const MetricDefinition = z.object({
  measure: MetricMeasure,
  /** Условия показателя: действуют всегда, до фильтров пользователя. */
  filter: FilterNode.nullable().default(null),
  /** Поле времени; null — поле времени датасета. */
  timeField: FieldRef.nullable().default(null),
  /** Допустимые разрезы значения. */
  dimensions: z.array(FieldRef).max(20).default([]),
  /** Период и сравнение по умолчанию — для карточки и плиток без своих настроек. */
  period: MetricPeriod.nullable().default({ unit: 'month', from: 0, to: 0 }),
  comparison: MetricComparison.default('previous_period'),
})
export type MetricDefinition = z.infer<typeof MetricDefinition>

const Name = z.string().trim().min(1).max(200)
const Description = z.string().trim().max(1000)
const Unit = z.string().trim().max(32)

export const MetricRecord = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  spaceId: Uuid,
  parentId: Uuid.nullable(),
  datasetId: Uuid,
  definition: MetricDefinition,
  unit: z.string().nullable(),
  format: FieldFormat.nullable(),
  direction: MetricDirection,
  targets: z.array(MetricTarget),
  thresholds: z.array(MetricThreshold),
})
export type MetricRecord = z.infer<typeof MetricRecord>

export const MetricCreateInput = z.object({
  name: Name,
  description: Description.nullish(),
  spaceId: Uuid,
  parentId: Uuid.nullable().optional(),
  datasetId: Uuid,
  definition: MetricDefinition,
  unit: Unit.nullish(),
  format: FieldFormat.nullish(),
  direction: MetricDirection.default('up'),
  targets: z.array(MetricTarget).max(10).default([]),
  thresholds: z.array(MetricThreshold).max(10).default([]),
})
export type MetricCreateInput = z.infer<typeof MetricCreateInput>

export const MetricUpdateInput = z
  .object({
    name: Name,
    description: Description.nullable(),
    datasetId: Uuid,
    definition: MetricDefinition,
    unit: Unit.nullable(),
    format: FieldFormat.nullable(),
    direction: MetricDirection,
    targets: z.array(MetricTarget).max(10),
    thresholds: z.array(MetricThreshold).max(10),
  })
  .partial()
export type MetricUpdateInput = z.infer<typeof MetricUpdateInput>

/** Запрос значения: без периода и сравнения — значения показателя по умолчанию. */
export const MetricValueInput = z.object({
  /** null — всё время. */
  period: MetricPeriod.nullable().optional(),
  comparison: MetricComparison.optional(),
  /** Фильтры пользователя — поверх условий показателя. */
  filter: FilterNode.optional(),
  /** Разрез значения: поля из допустимых разрезов показателя. */
  dimensions: z.array(FieldRef).max(3).default([]),
  /** История значения по единицам периода — для искры. */
  series: z.boolean().default(true),
})
export type MetricValueInput = z.infer<typeof MetricValueInput>

/** Окно значения: моменты начала и конца (конец не входит). */
export const MetricWindow = z.object({ from: Timestamp, to: Timestamp })
export type MetricWindow = z.infer<typeof MetricWindow>

export const MetricDelta = z.object({
  absolute: z.number(),
  /** Доля от базы; null — база нулевая. */
  relative: z.number().nullable(),
  direction: z.enum(['up', 'down', 'flat']),
  /** Хорошо ли изменение с учётом направления показателя; null — нейтрально. */
  good: z.boolean().nullable(),
})
export type MetricDelta = z.infer<typeof MetricDelta>

export const MetricValue = z.object({
  metricId: Uuid,
  name: z.string(),
  unit: z.string().nullable(),
  format: FieldFormat.nullable(),
  direction: MetricDirection,
  period: MetricPeriod.nullable(),
  comparison: MetricComparison,
  /** Окно значения; null — всё время. */
  window: MetricWindow.nullable(),
  /** Окно базы сравнения (предыдущий период, год назад); у цели — null. */
  baseWindow: MetricWindow.nullable(),
  value: z.number().nullable(),
  /** База сравнения: значение в окне базы или цель. */
  base: z.number().nullable(),
  delta: MetricDelta.nullable(),
  target: z.number().nullable(),
  status: MetricStatus.nullable(),
  /** История по единицам периода: начало единицы (дата) и значение. */
  series: z.array(z.object({ period: DateOnly, value: z.number().nullable() })),
  breakdown: z.array(
    z.object({
      values: z.record(z.string(), z.unknown()),
      value: z.number().nullable(),
      base: z.number().nullable(),
    }),
  ),
})
export type MetricValue = z.infer<typeof MetricValue>
