import {
  type DashboardFilter,
  type DashboardTile,
  type FilterNode,
  type MetricComparison,
  type MetricCreateInput,
  type MetricDefinition,
  type MetricDelta,
  type MetricMeasure,
  MetricPeriod,
  type MetricPeriodUnit,
  type MetricRecord,
  type MetricStatus,
  type MetricTarget,
  type MetricThreshold,
  type MetricUpdateInput,
  type MetricValue,
  type MetricWindow,
  type QueryResult,
  QuerySpec,
} from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { systemDataset } from '~/kernel/system-datasets.js'
import { config } from '~/shared/config/index.js'
import type { Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { metrics, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { filterCondition } from './dashboard-filters.js'
import { DatasetService } from './dataset-service.js'
import {
  fromWall,
  metricWindows,
  shift,
  toWall,
  truncate,
  type WallWindow,
  wallDate,
  wallDateAfter,
} from './metric-period.js'
import { QueryService } from './query-service.js'

/** Строк разреза не больше: плитка и карточка показывают верхушку. */
const BREAKDOWN_LIMIT = 50
/** Сколько единиц периода в истории значения (искре). */
const SERIES_POINTS: Record<MetricPeriodUnit, number> = {
  day: 14,
  week: 12,
  month: 12,
  quarter: 8,
  year: 5,
}
/** История по дням — не длиннее квартала. */
const MAX_DAYS = 92
/** «Всё время» — история по годам. */
const ALL_TIME_YEARS = 10
const DAY_MS = 86_400_000
/** Пустое окно для этих агрегатов — ноль, а не «нет значения». */
const ZERO_WHEN_EMPTY = new Set(['count', 'count_distinct', 'sum'])

/** Поле времени показателя: из определения или поле времени датасета. */
interface TimeField {
  key: string
  type: 'date' | 'datetime'
}

/** Как считать значение: без полей — по умолчанию показателя. */
export interface MetricEvaluation {
  /** null — всё время; не задан — период показателя. */
  period?: MetricPeriod | null | undefined
  comparison?: MetricComparison | undefined
  /** Фильтры пользователя поверх условий показателя. */
  filter?: FilterNode | null | undefined
  dimensions?: string[] | undefined
  series?: boolean | undefined
}

type MetricSource = Pick<MetricRecord, 'datasetId' | 'systemSource' | 'definition'>

/** Схема источника показателя: поля с типами и поле времени по умолчанию. */
interface SourceSchema {
  fields: ReadonlyArray<{ key: string; type: string }>
  timeField: string | null
}

/** Источник запросов показателя: датасет или системный датасет (ADR-0082). */
function querySource(source: MetricSource) {
  if (source.systemSource) return { kind: 'system', name: source.systemSource } as const
  if (!source.datasetId) throw errors.validation('У показателя нет источника данных')
  return { kind: 'dataset', id: source.datasetId } as const
}

/**
 * Схема источника: у датасета — его поля, у системного датасета — поля
 * представления с правами смотрящего (скрытые политикой столбцов — без них).
 */
async function schemaOf(ctx: Ctx, source: MetricSource): Promise<SourceSchema> {
  if (source.systemSource) {
    const definition = systemDataset(source.systemSource)
    if (!definition)
      throw errors.validation(`Системный датасет «${source.systemSource}» недоступен`)
    const resolved = await definition.resolve(ctx)
    const hidden = new Set(resolved.columnPolicy.hide)
    return {
      fields: resolved.fields.filter((field) => !hidden.has(field.key)),
      timeField: definition.timeField ?? null,
    }
  }
  if (!source.datasetId) throw errors.validation('У показателя нет источника данных')
  return DatasetService.get(source.datasetId)
}

const and = (nodes: FilterNode[]): FilterNode | null =>
  nodes.length === 0 ? null : nodes.length === 1 ? (nodes[0] as FilterNode) : { and: nodes }

function measureOf(measure: MetricMeasure, alias: string, filter?: FilterNode | null) {
  return {
    alias,
    agg: measure.agg,
    ...(measure.field ? { field: measure.field } : {}),
    ...(measure.expr ? { expr: measure.expr } : {}),
    ...(filter ? { filter } : {}),
  }
}

function timeFieldIn(dataset: SourceSchema, definition: MetricDefinition): TimeField | null {
  const key = definition.timeField ?? dataset.timeField
  if (!key) return null
  const field = dataset.fields.find((item) => item.key === key)
  if (!field || (field.type !== 'date' && field.type !== 'datetime')) {
    throw errors.validation(`Поле времени «${key}» — не дата и не дата со временем`)
  }
  return { key, type: field.type }
}

async function timeFieldOf(ctx: Ctx, source: MetricSource): Promise<TimeField | null> {
  return timeFieldIn(await schemaOf(ctx, source), source.definition)
}

/** Условие «в окне» над полем времени: для дат — целые дни, для моментов — в поясе. */
function within(time: TimeField, window: WallWindow, timezone: string): FilterNode {
  const [from, to] =
    time.type === 'date'
      ? [wallDate(window.from), wallDateAfter(window.to)]
      : [fromWall(window.from, timezone).toISOString(), fromWall(window.to, timezone).toISOString()]
  return {
    and: [
      { field: time.key, op: 'gte', value: from },
      { field: time.key, op: 'lt', value: to },
    ],
  }
}

function momentWindow(window: WallWindow | null, timezone: string): MetricWindow | null {
  if (!window) return null
  return {
    from: fromWall(window.from, timezone).toISOString(),
    to: fromWall(window.to, timezone).toISOString(),
  }
}

/** Цель на единицу периода, иначе цель без единицы. */
function targetFor(targets: MetricTarget[], unit: MetricPeriodUnit | null): number | null {
  const exact = unit ? targets.find((target) => target.unit === unit) : undefined
  return (exact ?? targets.find((target) => target.unit === null))?.value ?? null
}

/** Порог: наибольший, не превышающий значения. */
function statusOf(thresholds: MetricThreshold[], value: number | null): MetricStatus | null {
  if (value === null) return null
  let status: MetricStatus | null = null
  for (const threshold of [...thresholds].sort((a, b) => a.value - b.value)) {
    if (value >= threshold.value) status = threshold.status
  }
  return status
}

function deltaOf(
  value: number | null,
  base: number | null,
  direction: MetricRecord['direction'],
): MetricDelta | null {
  if (value === null || base === null) return null
  const absolute = value - base
  const trend = absolute > 0 ? 'up' : absolute < 0 ? 'down' : 'flat'
  return {
    absolute,
    relative: base !== 0 ? absolute / Math.abs(base) : null,
    direction: trend,
    good:
      trend === 'flat' || direction === 'neutral'
        ? null
        : (trend === 'up') === (direction === 'up'),
  }
}

function numberAt(result: QueryResult, row: unknown[] | undefined, name: string): number | null {
  const index = result.fields.findIndex((field) => field.name === name)
  const value = index >= 0 && row ? row[index] : null
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Единица истории для окна дат: дни, недели или месяцы по длине. */
function bucketForLength(window: WallWindow): MetricPeriodUnit {
  const days = (window.to - window.from) / DAY_MS
  return days <= 62 ? 'day' : days <= 182 ? 'week' : 'month'
}

/**
 * Спецификации значения показателя: итог (значение и база — условные меры одного
 * запроса), разрез и история. Их выполняет QueryService с политиками смотрящего.
 */
function plan(
  source: MetricSource,
  time: TimeField | null,
  evaluation: MetricEvaluation,
  timezone: string,
  now: Date,
) {
  const definition = source.definition
  const period = evaluation.period === undefined ? definition.period : evaluation.period
  if (period !== null && !time) {
    throw errors.validation('У показателя нет поля времени — считается только «за всё время»')
  }
  const comparison = evaluation.comparison ?? definition.comparison
  const windows = metricWindows(time ? period : null, comparison, now, timezone)
  const current = time && windows.current ? within(time, windows.current, timezone) : null
  const base = time && windows.base ? within(time, windows.base, timezone) : null
  const scope: FilterNode[] = [
    ...(definition.filter ? [definition.filter] : []),
    ...(evaluation.filter ? [evaluation.filter] : []),
  ]
  const where = and([...scope, ...(current ? [base ? { or: [current, base] } : current] : [])])

  const totals = (groupBy: string[]) =>
    QuerySpec.parse({
      version: 1,
      source: querySource(source),
      steps: [
        ...(where ? [{ type: 'filter', where }] : []),
        {
          type: 'aggregate',
          groupBy: groupBy.map((field) => ({ field })),
          measures: [
            measureOf(definition.measure, 'value', base ? current : null),
            ...(base ? [measureOf(definition.measure, 'base', base)] : []),
          ],
        },
        ...(groupBy.length > 0
          ? [
              { type: 'sort', by: [{ field: 'value', dir: 'desc', nulls: 'last' }] },
              { type: 'limit', limit: BREAKDOWN_LIMIT, offset: 0 },
            ]
          : []),
      ],
    })

  const dimensions = evaluation.dimensions ?? []
  for (const dimension of dimensions) {
    if (!definition.dimensions.includes(dimension)) {
      throw errors.validation(`Разрез «${dimension}» не входит в допустимые разрезы показателя`)
    }
  }

  let series: { spec: QuerySpec; keys: string[] } | null = null
  if (time && evaluation.series !== false) {
    // История кончается периодом значения: у относительного — несколько единиц до него
    let unit: MetricPeriodUnit
    let window: WallWindow
    if (windows.current && windows.unit) {
      unit = windows.unit
      const days = Math.round((windows.current.to - windows.current.from) / DAY_MS)
      const points =
        unit === 'day' ? Math.min(Math.max(SERIES_POINTS.day, days), MAX_DAYS) : SERIES_POINTS[unit]
      window = { from: shift(windows.current.to, unit, -points), to: windows.current.to }
    } else if (windows.current) {
      unit = bucketForLength(windows.current)
      window = windows.current
    } else {
      unit = 'year'
      const year = truncate(toWall(now, timezone), 'year')
      window = { from: shift(year, 'year', 1 - ALL_TIME_YEARS), to: shift(year, 'year', 1) }
    }
    const keys: string[] = []
    for (let at = truncate(window.from, unit); at < window.to; at = shift(at, unit, 1)) {
      keys.push(wallDate(at))
    }
    series = {
      keys,
      spec: QuerySpec.parse({
        version: 1,
        source: querySource(source),
        steps: [
          { type: 'filter', where: and([...scope, within(time, window, timezone)]) },
          {
            type: 'aggregate',
            groupBy: [{ field: time.key, bucket: unit, alias: 'period' }],
            measures: [measureOf(definition.measure, 'value')],
          },
          { type: 'sort', by: [{ field: 'period', dir: 'asc' }] },
        ],
      }),
    }
  }

  return {
    period,
    comparison,
    windows,
    totals: totals([]),
    breakdown: dimensions.length > 0 ? totals(dimensions) : null,
    series,
  }
}

function timezoneOf(ctx: Ctx): string {
  return ctx.kind === 'user' ? ctx.timezone : config().TZ
}

/** Период из значения фильтра-периода дашборда: относительный, пара дат или всё время. */
function periodOfFilter(value: unknown): MetricPeriod | null {
  if (Array.isArray(value) && value.length === 2) {
    const parsed = MetricPeriod.safeParse({ start: value[0], end: value[1] })
    return parsed.success ? parsed.data : null
  }
  const parsed = MetricPeriod.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Определение показателя проверяется компилятором с правами автора — сохранить можно только то, что посчитается. */
async function validate(ctx: Ctx, source: MetricSource): Promise<void> {
  if (source.datasetId) await authorize(ctx, 'view', source.datasetId)
  const dataset = await schemaOf(ctx, source)
  const time = timeFieldIn(dataset, source.definition)
  const keys = new Set(dataset.fields.map((field) => field.key))
  for (const dimension of source.definition.dimensions) {
    if (!keys.has(dimension)) throw errors.validation(`Нет поля «${dimension}» для разреза`)
  }
  const planned = plan(
    source,
    time,
    { dimensions: source.definition.dimensions },
    timezoneOf(ctx),
    new Date(),
  )
  for (const spec of [planned.totals, planned.breakdown, planned.series?.spec]) {
    if (spec) await QueryService.compile(ctx, spec)
  }
}

function toRecord(
  row: typeof metrics.$inferSelect,
  object: typeof objects.$inferSelect,
): MetricRecord {
  if (!object.spaceId || (!row.datasetId && !row.systemSource)) {
    throw errors.notFound('Показатель')
  }
  return {
    id: row.id,
    name: object.title,
    description: object.subtitle,
    spaceId: object.spaceId,
    parentId: object.parentId,
    datasetId: row.datasetId,
    systemSource: (row.systemSource as MetricRecord['systemSource']) ?? null,
    definition: row.definition as unknown as MetricDefinition,
    unit: row.unit,
    format: (row.format as MetricRecord['format']) ?? null,
    direction: row.direction as MetricRecord['direction'],
    targets: row.targets as unknown as MetricTarget[],
    thresholds: row.thresholds as unknown as MetricThreshold[],
  }
}

/**
 * Показатели (06-analytics-engine.md §7, ADR-0058). Значение считается одним
 * путём — `evaluate`: его вызывают API, плитка дашборда и карточка; запросы
 * идут через QueryService с политиками строк и столбцов смотрящего.
 */
export const MetricService = {
  async create(
    tx: Executor,
    ctx: Ctx,
    input: MetricCreateInput,
    options: { systemKey?: string } = {},
  ): Promise<string> {
    const source: MetricSource = {
      datasetId: input.datasetId ?? null,
      systemSource: input.systemSource ?? null,
      definition: input.definition,
    }
    await validate(ctx, source)
    const object = await ObjectService.create(tx, ctx, {
      type: 'metric',
      spaceId: input.spaceId,
      parentId: input.parentId ?? null,
      title: input.name,
      subtitle: input.description?.trim() || null,
      meta: {
        unit: input.unit ?? null,
        direction: input.direction,
        // Показатель, который ищет модуль (контроль исполнения, ADR-0082)
        ...(options.systemKey ? { systemKey: options.systemKey } : {}),
      },
    })
    await tx.insert(metrics).values({
      id: object.id,
      datasetId: source.datasetId,
      systemSource: source.systemSource,
      definition: input.definition as unknown as Record<string, unknown>,
      unit: input.unit?.trim() || null,
      format: input.format ?? null,
      direction: input.direction,
      targets: input.targets,
      thresholds: input.thresholds,
    })
    await LinkService.setDependencies(tx, object.id, source.datasetId ? [source.datasetId] : [])
    return object.id
  },

  async get(id: string, executor: Executor = db()): Promise<MetricRecord> {
    const [row] = await executor
      .select({ metric: metrics, object: objects })
      .from(metrics)
      .innerJoin(objects, eq(objects.id, metrics.id))
      .where(eq(metrics.id, id))
      .limit(1)
    if (!row) throw errors.notFound('Показатель')
    return toRecord(row.metric, row.object)
  },

  async update(tx: Executor, ctx: Ctx, id: string, input: MetricUpdateInput): Promise<void> {
    const current = await MetricService.get(id, tx)
    const changed: string[] = []
    if (input.name !== undefined || input.description !== undefined) {
      await ObjectService.update(tx, ctx, id, {
        ...(input.name !== undefined ? { title: input.name } : {}),
        ...(input.description !== undefined ? { subtitle: input.description?.trim() || null } : {}),
      })
      if (input.name !== undefined) changed.push('name')
      if (input.description !== undefined) changed.push('description')
    }
    // Датасет вместо системного источника — показатель переходит на датасет
    const next: MetricSource = {
      datasetId: input.datasetId ?? current.datasetId,
      systemSource: input.datasetId ? null : current.systemSource,
      definition: input.definition ?? current.definition,
    }
    if (input.datasetId !== undefined || input.definition !== undefined) await validate(ctx, next)
    const data = {
      ...(input.datasetId !== undefined ? { datasetId: input.datasetId, systemSource: null } : {}),
      ...(input.definition !== undefined
        ? { definition: input.definition as unknown as Record<string, unknown> }
        : {}),
      ...(input.unit !== undefined ? { unit: input.unit?.trim() || null } : {}),
      ...(input.format !== undefined ? { format: input.format } : {}),
      ...(input.direction !== undefined ? { direction: input.direction } : {}),
      ...(input.targets !== undefined ? { targets: input.targets } : {}),
      ...(input.thresholds !== undefined ? { thresholds: input.thresholds } : {}),
    }
    const keys = Object.keys(data)
    if (keys.length > 0) {
      await tx.update(metrics).set(data).where(eq(metrics.id, id))
      if (input.datasetId !== undefined) {
        await LinkService.setDependencies(tx, id, [input.datasetId])
      }
      if (input.unit !== undefined || input.direction !== undefined) {
        await ObjectService.update(
          tx,
          ctx,
          id,
          {
            meta: {
              unit: input.unit !== undefined ? input.unit?.trim() || null : current.unit,
              direction: input.direction ?? current.direction,
            },
            mergeMeta: true,
          },
          { silent: true },
        )
      }
      changed.push(...keys)
    }
    if (changed.length === 0) return
    const [object] = await tx
      .select({ spaceId: objects.spaceId, title: objects.title })
      .from(objects)
      .where(eq(objects.id, id))
      .limit(1)
    await publishEvent(tx, ctx, {
      type: 'metric.updated',
      object: { id, type: 'metric', spaceId: object?.spaceId ?? null, title: object?.title },
      payload: { changed },
    })
  },

  /** Значение показателя: итог, база сравнения, статус порога, разрез и история. */
  async evaluate(
    ctx: Ctx,
    metric: MetricRecord,
    evaluation: MetricEvaluation = {},
  ): Promise<MetricValue> {
    const timezone = timezoneOf(ctx)
    const time = await timeFieldOf(ctx, metric)
    const planned = plan(metric, time, evaluation, timezone, new Date())
    const zero = ZERO_WHEN_EMPTY.has(metric.definition.measure.agg)
    const orZero = (value: number | null) => (value === null && zero ? 0 : value)

    const [totals, breakdown, history] = await Promise.all([
      QueryService.run(ctx, planned.totals),
      planned.breakdown ? QueryService.run(ctx, planned.breakdown) : Promise.resolve(null),
      planned.series ? QueryService.run(ctx, planned.series.spec) : Promise.resolve(null),
    ])

    const row = totals.rows[0]
    const value = orZero(numberAt(totals, row, 'value'))
    const target = targetFor(metric.targets, planned.windows.unit)
    const hasBase = planned.windows.base !== null
    const base =
      planned.comparison === 'target'
        ? target
        : hasBase
          ? orZero(numberAt(totals, row, 'base'))
          : null

    let series: MetricValue['series'] = []
    if (history && planned.series) {
      const periodIndex = history.fields.findIndex((field) => field.name === 'period')
      const byPeriod = new Map(
        history.rows.map((item) => [String(item[periodIndex]), numberAt(history, item, 'value')]),
      )
      series = planned.series.keys.map((period) => ({
        period,
        value: orZero(byPeriod.get(period) ?? null),
      }))
    }

    const dimensionNames = evaluation.dimensions ?? []
    return {
      metricId: metric.id,
      name: metric.name,
      unit: metric.unit,
      format: metric.format,
      direction: metric.direction,
      period: planned.period,
      comparison: planned.comparison,
      window: momentWindow(planned.windows.current, timezone),
      baseWindow: momentWindow(planned.windows.base, timezone),
      value,
      base,
      delta: planned.comparison === 'none' ? null : deltaOf(value, base, metric.direction),
      target,
      status: statusOf(metric.thresholds, value),
      series,
      breakdown: breakdown
        ? breakdown.rows.map((item) => ({
            values: Object.fromEntries(
              dimensionNames.map((name) => [
                name,
                item[breakdown.fields.findIndex((field) => field.name === name)] ?? null,
              ]),
            ),
            value: orZero(numberAt(breakdown, item, 'value')),
            base: hasBase ? orZero(numberAt(breakdown, item, 'base')) : null,
          }))
        : [],
    }
  },

  /**
   * Значение плитки дашборда: фильтр-период, привязанный к полю времени
   * показателя, задаёт период (пустой — всё время); остальные привязанные
   * фильтры — условия, как у графиков.
   */
  async tileValue(
    ctx: Ctx,
    metric: MetricRecord,
    tile: DashboardTile,
    filters: DashboardFilter[],
    values: Record<string, unknown>,
  ): Promise<MetricValue> {
    const time = await timeFieldOf(ctx, metric)
    let period = tile.metric?.period
    const conditions: FilterNode[] = []
    for (const filter of filters) {
      const field = tile.filterBindings[filter.id]
      if (!field) continue
      const value = filter.id in values ? values[filter.id] : filter.default
      if (filter.kind === 'period' && time && field === time.key) {
        period = periodOfFilter(value)
        continue
      }
      const condition = filterCondition(filter, field, value)
      if (condition) conditions.push(condition)
    }
    return MetricService.evaluate(ctx, metric, {
      period,
      comparison: tile.metric?.comparison,
      filter: and(conditions),
    })
  },

  /** История показателя как результат запроса — для графиков по показателю (`data.metricId`). */
  async seriesResult(
    ctx: Ctx,
    metric: MetricRecord,
    transform: (query: QuerySpec) => QuerySpec = (query) => query,
  ): Promise<QueryResult> {
    const time = await timeFieldOf(ctx, metric)
    if (!time) throw errors.validation('У показателя нет поля времени — истории нет')
    const planned = plan(metric, time, {}, timezoneOf(ctx), new Date())
    if (!planned.series) throw errors.validation('У показателя нет истории')
    return QueryService.run(ctx, transform(planned.series.spec))
  },
}
