import {
  type DatasetRecord,
  type FieldType,
  type FilterNode,
  type PassportChild,
  type PassportDataset,
  type PassportMeasure,
  type PassportMetric,
  type PassportPeriod,
  type QueryResult,
  QuerySpec,
  type QueryStep,
  TerritoryLevel,
  type TerritoryPassport,
} from '@kchs/contracts'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { LinkService } from '~/kernel/links/service.js'
import { DatasetCatalog, DatasetQueries, datasetRecord, Metrics } from '~/modules/data/public.js'
import { TaskQueries } from '~/modules/tasks/public.js'
import { config } from '~/shared/config/index.js'
import type { Ctx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { objects, territories } from '~/shared/db/schema/index.js'
import { AppError } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { LayerService } from './layer-service.js'
import { type PeriodPlan, periodPlan } from './passport-period.js'
import { territoryIndex } from './territory-index.js'
import { TerritoryService } from './territory-service.js'

/** Датасетов с полем территории в паспорте — не больше. */
const MAX_DATASETS = 30
/** Сумм мер на датасет: самые первые меры схемы. */
const MAX_MEASURES = 3
/** Одновременных запросов паспорта: пул роли запросов общий с остальными. */
const PARALLEL = 3
const NUMERIC = new Set<FieldType>(['integer', 'number', 'decimal', 'money', 'percent'])
/** Служебное имя территории-разреза в запросе по дочерним единицам. */
const CHILD = 'passport_child'

/** Меры датасета для паспорта: числовые поля с семантикой меры по порядку схемы. */
function measuresOf(dataset: DatasetRecord) {
  return dataset.fields
    .filter((field) => field.semantic === 'measure' && NUMERIC.has(field.type))
    .slice(0, MAX_MEASURES)
}

const numberOf = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Строки результата — объектами по именам полей. */
function records(result: QueryResult): Array<Record<string, unknown>> {
  return result.rows.map((row) =>
    Object.fromEntries(result.fields.map((field, index) => [field.name, row[index]])),
  )
}

const spec = (datasetId: string, steps: QueryStep[]): QuerySpec =>
  QuerySpec.parse({ version: 1, source: { kind: 'dataset', id: datasetId }, steps })

/** Выполняет задачи не больше `limit` одновременно, порядок результатов — как у входа. */
async function limited<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await run(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Ошибка показателя — понятной строкой: один датасет (нет доступа к полю,
 * тайм-аут, сбой политики) не должен ронять весь паспорт.
 */
function reason(error: unknown, datasetId: string): string {
  if (error instanceof AppError) return error.message
  logger().warn({ err: error, datasetId }, 'показатель паспорта территории не посчитан')
  return 'Показатель не посчитан'
}

/**
 * Показатели датасета по территории: строки и суммы мер за период и за
 * предыдущий период, строки по месяцам и по дочерним единицам — компилятором
 * запросов с политиками смотрящего (фильтр `within` — с вложенными единицами).
 */
async function datasetStats(
  ctx: Ctx,
  dataset: DatasetRecord,
  territoryId: string,
  plan: PeriodPlan,
  childLevel: TerritoryLevel | null,
): Promise<PassportDataset> {
  const territoryField = dataset.territoryField as string
  const measures = measuresOf(dataset)
  const geometryField = dataset.fields.find((field) => field.type === 'geometry')?.key ?? null
  const base: PassportDataset = {
    id: dataset.id,
    name: dataset.name,
    spaceId: dataset.spaceId,
    territoryField,
    timeField: dataset.timeField,
    geometryField,
    rows: null,
    previousRows: null,
    measures: measures.map((field) => ({
      key: field.key,
      label: field.label,
      format: field.format ?? null,
      value: null,
      previous: null,
    })),
    series: [],
    children: {},
    layers: await LayerService.forDataset(ctx, dataset.id),
    error: null,
  }
  const within: FilterNode = { field: territoryField, op: 'within', value: territoryId }
  const timed = Boolean(dataset.timeField && plan.both && plan.current)
  const sums = measures.map((field, index) => ({
    alias: `m_${index}`,
    agg: 'sum' as const,
    field: field.key,
  }))
  try {
    if (timed) {
      const time = dataset.timeField as string
      const result = await DatasetQueries.run(
        ctx,
        spec(dataset.id, [
          {
            type: 'filter',
            where: { and: [within, { field: time, op: 'relative', value: plan.both }] },
          },
          {
            type: 'aggregate',
            groupBy: [{ field: time, bucket: 'month', alias: 'month' }],
            measures: [{ alias: 'rows', agg: 'count' }, ...sums],
          },
        ]),
      )
      const firstMonth = plan.months[0] as string
      const byMonth = new Map<string, number>()
      let rows = 0
      let previousRows = 0
      const current = measures.map(() => null as number | null)
      const previous = measures.map(() => null as number | null)
      const add = (list: Array<number | null>, index: number, value: number | null) => {
        if (value === null) return
        list[index] = (list[index] ?? 0) + value
      }
      for (const row of records(result)) {
        const month = String(row.month ?? '')
        const count = numberOf(row.rows) ?? 0
        const inCurrent = month >= firstMonth
        if (inCurrent) {
          rows += count
          byMonth.set(month, count)
        } else previousRows += count
        measures.forEach((_, index) => {
          add(inCurrent ? current : previous, index, numberOf(row[`m_${index}`]))
        })
      }
      base.rows = rows
      base.previousRows = previousRows
      base.series = plan.months.map((period) => ({ period, rows: byMonth.get(period) ?? 0 }))
      base.measures = base.measures.map(
        (measure, index): PassportMeasure => ({
          ...measure,
          value: current[index] ?? null,
          previous: previous[index] ?? null,
        }),
      )
    } else {
      const result = await DatasetQueries.run(
        ctx,
        spec(dataset.id, [
          { type: 'filter', where: within },
          { type: 'aggregate', groupBy: [], measures: [{ alias: 'rows', agg: 'count' }, ...sums] },
        ]),
      )
      const [row] = records(result)
      base.rows = numberOf(row?.rows) ?? 0
      base.measures = base.measures.map((measure, index) => ({
        ...measure,
        value: numberOf(row?.[`m_${index}`]),
      }))
    }
    if (childLevel) {
      const where: FilterNode =
        timed && plan.current
          ? {
              and: [
                within,
                { field: dataset.timeField as string, op: 'relative', value: plan.current },
              ],
            }
          : within
      const result = await DatasetQueries.run(
        ctx,
        spec(dataset.id, [
          { type: 'filter', where },
          {
            type: 'compute',
            fields: [{ name: CHILD, expr: `territory_level(${territoryField}, '${childLevel}')` }],
          },
          {
            type: 'aggregate',
            groupBy: [{ field: CHILD }],
            measures: [{ alias: 'rows', agg: 'count' }],
          },
        ]),
      )
      for (const row of records(result)) {
        if (typeof row[CHILD] === 'string') base.children[row[CHILD]] = numberOf(row.rows) ?? 0
      }
    }
  } catch (error) {
    base.rows = null
    base.previousRows = null
    base.error = reason(error, dataset.id)
  }
  return base
}

/** Дочерние единицы: население из атрибутов справочника, площадь, наличие границы. */
async function childrenOf(territoryId: string): Promise<PassportChild[]> {
  const rows = await db()
    .select({
      id: territories.id,
      code: territories.code,
      level: territories.level,
      name: territories.name,
      population: sql<string | null>`${territories.attributes}->>'population'`,
      areaKm2: territories.areaKm2,
      hasGeometry: sql<boolean>`${territories.geom} IS NOT NULL`,
    })
    .from(territories)
    .innerJoin(objects, eq(objects.id, territories.id))
    .where(and(eq(territories.parentId, territoryId), isNull(objects.deletedAt)))
    .orderBy(asc(territories.code))
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    level: TerritoryLevel.parse(row.level),
    name: row.name,
    population: numberOf(row.population),
    areaKm2: row.areaKm2,
    hasGeometry: row.hasGeometry,
  }))
}

/** Уровень большинства дочерних единиц. */
function commonLevel(children: PassportChild[]): TerritoryLevel | null {
  const counts = new Map<TerritoryLevel, number>()
  for (const child of children) counts.set(child.level, (counts.get(child.level) ?? 0) + 1)
  let best: TerritoryLevel | null = null
  for (const [level, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) best = level
  }
  return best
}

/**
 * Показатели, привязанные к территории или её предку связью `about_territory`
 * (ADR-0077): значение — с фильтром `within` по полю территории датасета
 * показателя; показатель без доступа или без поля территории не показывается.
 */
async function linkedMetrics(ctx: Ctx, territoryId: string): Promise<PassportMetric[]> {
  const index = await territoryIndex()
  const chain = [...index.ancestors(territoryId).map((item) => item.id), territoryId]
  // Ближайшая к единице привязка побеждает: цепочка — от корня
  const linkedTo = new Map<string, string>()
  for (const id of chain) {
    for (const source of await LinkService.objectsLinkedTo(id, 'about_territory')) {
      linkedTo.set(source, id)
    }
  }
  if (linkedTo.size === 0) return []
  const rows = await db()
    .select({ id: objects.id })
    .from(objects)
    .where(
      and(
        inArray(objects.id, [...linkedTo.keys()]),
        eq(objects.type, 'metric'),
        isNull(objects.deletedAt),
      ),
    )
    .orderBy(asc(objects.title))
  const values: PassportMetric[] = []
  for (const { id } of rows) {
    const allowed = await authorize(ctx, 'view', id, { soft: true })
    if (!allowed.allowed) continue
    try {
      const metric = await Metrics.get(id)
      // Показатель над системным датасетом поля территории не имеет (ADR-0082)
      if (!metric.datasetId) continue
      const dataset = await datasetRecord(metric.datasetId)
      if (!dataset.territoryField) continue
      const value = await Metrics.value(ctx, metric, {
        filter: { field: dataset.territoryField, op: 'within', value: territoryId },
        series: true,
      })
      values.push({ ...value, linkedTo: linkedTo.get(id) as string })
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      logger().debug({ err: error, metricId: id }, 'показатель паспорта не посчитан')
    }
  }
  return values
}

/**
 * Паспорт территории (07-gis-engine.md §11, 03-screens.md §11, ADR-0077):
 * собирается по полям территории датасетов, связям `about_territory`
 * показателей и задачам с территорией — всё с правами смотрящего.
 */
export const PassportService = {
  async get(ctx: Ctx, territoryId: string, period: PassportPeriod): Promise<TerritoryPassport> {
    // Карточка проверяет право видеть единицу справочника
    await TerritoryService.get(ctx, territoryId)
    const index = await territoryIndex()
    const timezone = ctx.kind === 'user' ? ctx.timezone : config().TZ
    const plan = periodPlan(period, new Date(), timezone)
    const children = await childrenOf(territoryId)
    const childLevel = commonLevel(children)
    const datasets = await DatasetCatalog.withTerritory(ctx, MAX_DATASETS)
    const [stats, metrics, tasks] = await Promise.all([
      limited(datasets, PARALLEL, (dataset) =>
        datasetStats(ctx, dataset, territoryId, plan, childLevel),
      ),
      linkedMetrics(ctx, territoryId),
      TaskQueries.territoryCounts(ctx, index.descendants(territoryId)),
    ])
    return {
      territoryId,
      period,
      window: plan.window,
      previousWindow: plan.previousWindow,
      datasets: stats,
      metrics,
      tasks,
      childLevel,
      children,
    }
  },
}
