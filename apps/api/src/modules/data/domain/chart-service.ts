import type {
  ChartCreateInput,
  ChartRecord,
  ChartSpec,
  ChartUpdateInput,
  QueryResult,
  QuerySpec,
} from '@kchs/contracts'
import { collectSources } from '@kchs/query'
import { eq } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import type { Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { charts, objects, queries } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { MetricService } from './metric-service.js'
import { QueryService } from './query-service.js'

interface ChartSources {
  datasetIds: string[]
  queryId: string | null
  metricId: string | null
}

/** Датасеты, сохранённый запрос или показатель, на которых построен график, — для зависимостей. */
function sourcesOf(spec: ChartSpec): ChartSources {
  if ('query' in spec.data) {
    return { datasetIds: collectSources(spec.data.query).datasets, queryId: null, metricId: null }
  }
  if ('queryId' in spec.data) return { datasetIds: [], queryId: spec.data.queryId, metricId: null }
  return { datasetIds: [], queryId: null, metricId: spec.data.metricId }
}

const dependencyIds = (sources: ChartSources) => [
  ...sources.datasetIds,
  ...(sources.queryId ? [sources.queryId] : []),
  ...(sources.metricId ? [sources.metricId] : []),
]

/** График строится только над данными, которые автор видит. */
async function assertSources(ctx: Ctx, spec: ChartSpec): Promise<ChartSources> {
  const sources = sourcesOf(spec)
  for (const id of dependencyIds(sources)) await authorize(ctx, 'view', id)
  return sources
}

/**
 * Данные графика: запрос спецификации выполняется с политиками того, кто
 * смотрит график (права на график не открывают данные — 03-access-model.md).
 * `transform` — фильтры дашборда поверх запроса плитки.
 */
export async function runChartSpec(
  ctx: Ctx,
  spec: ChartSpec,
  params: Record<string, unknown> = {},
  transform: (query: QuerySpec) => QuerySpec = (query) => query,
): Promise<QueryResult> {
  if ('query' in spec.data) return QueryService.run(ctx, transform(spec.data.query), { params })
  if ('queryId' in spec.data) {
    await authorize(ctx, 'view', spec.data.queryId)
    const [saved] = await db()
      .select({ spec: queries.spec })
      .from(queries)
      .where(eq(queries.id, spec.data.queryId))
      .limit(1)
    if (!saved) throw errors.notFound('Запрос')
    return QueryService.run(ctx, transform(saved.spec as unknown as QuerySpec), {
      params,
      queryId: spec.data.queryId,
    })
  }
  // График по показателю — его история; значение и сравнения — у плитки показателя
  await authorize(ctx, 'view', spec.data.metricId)
  return MetricService.seriesResult(ctx, await MetricService.get(spec.data.metricId), transform)
}

/** Графики — объекты реестра типа `chart` (06-analytics-engine.md §8). */
export const ChartService = {
  async create(tx: Executor, ctx: Ctx, input: ChartCreateInput): Promise<string> {
    const sources = await assertSources(ctx, input.spec)
    const object = await ObjectService.create(tx, ctx, {
      type: 'chart',
      spaceId: input.spaceId,
      parentId: input.parentId ?? null,
      title: input.name,
      meta: { chartType: input.spec.type },
    })
    await tx.insert(charts).values({
      id: object.id,
      spec: input.spec as unknown as Record<string, unknown>,
      queryId: sources.queryId,
      datasetIds: sources.datasetIds,
    })
    await LinkService.setDependencies(tx, object.id, dependencyIds(sources))
    return object.id
  },

  async get(id: string, executor: Executor = db()): Promise<ChartRecord> {
    const [row] = await executor
      .select({ chart: charts, object: objects })
      .from(charts)
      .innerJoin(objects, eq(objects.id, charts.id))
      .where(eq(charts.id, id))
      .limit(1)
    if (!row?.object.spaceId) throw errors.notFound('График')
    return {
      id,
      name: row.object.title,
      spaceId: row.object.spaceId,
      parentId: row.object.parentId,
      spec: row.chart.spec as unknown as ChartSpec,
      paramsDefaults: row.chart.paramsDefaults ?? {},
    }
  },

  async update(tx: Executor, ctx: Ctx, id: string, input: ChartUpdateInput): Promise<void> {
    const changed: string[] = []
    if (input.name !== undefined) {
      await ObjectService.update(tx, ctx, id, { title: input.name })
      changed.push('name')
    }
    if (input.spec) {
      const sources = await assertSources(ctx, input.spec)
      await tx
        .update(charts)
        .set({
          spec: input.spec as unknown as Record<string, unknown>,
          queryId: sources.queryId,
          datasetIds: sources.datasetIds,
        })
        .where(eq(charts.id, id))
      await LinkService.setDependencies(tx, id, dependencyIds(sources))
      await ObjectService.update(
        tx,
        ctx,
        id,
        { meta: { chartType: input.spec.type }, mergeMeta: true },
        { silent: true },
      )
      changed.push('spec')
    }
    if (changed.length === 0) return
    const [object] = await tx
      .select({ spaceId: objects.spaceId, title: objects.title })
      .from(objects)
      .where(eq(objects.id, id))
      .limit(1)
    await publishEvent(tx, ctx, {
      type: 'chart.updated',
      object: { id, type: 'chart', spaceId: object?.spaceId ?? null, title: object?.title },
      payload: { changed },
    })
  },
}
