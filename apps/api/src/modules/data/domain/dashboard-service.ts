import type {
  ChartSpec,
  DashboardCreateInput,
  DashboardData,
  DashboardDataInput,
  DashboardDrillInput,
  DashboardDrillResult,
  DashboardRecord,
  DashboardSpec,
  DashboardTileData,
  DashboardUpdateInput,
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
import { dashboards, objects } from '~/shared/db/schema/index.js'
import { errors, isAppError } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { ChartService, runChartSpec } from './chart-service.js'
import { applyDashboardFilters } from './dashboard-filters.js'
import { drillSpec } from './drill.js'
import { MetricService } from './metric-service.js'
import { QueryService } from './query-service.js'

/**
 * Плитки с данными: график (сохранённый или встроенный), таблица и показатель.
 * Плитка-карта читает тайлы слоёв сама — с условиями фильтров дашборда (ADR-0074).
 */
const DATA_TILES = new Set(['chart', 'table', 'metric'])

/** Графики, показатели, карты и датасеты плиток — зависимости дашборда («Используется в»). */
function dependenciesOf(spec: DashboardSpec): string[] {
  const ids = new Set<string>()
  for (const tile of spec.tiles) {
    if (tile.chartId) ids.add(tile.chartId)
    if (tile.metricId) ids.add(tile.metricId)
    if (tile.mapId) ids.add(tile.mapId)
    if (tile.spec && 'query' in tile.spec.data) {
      for (const id of collectSources(tile.spec.data.query).datasets) ids.add(id)
    }
  }
  return [...ids]
}

/** Плитка ссылается только на то, что автор видит. */
async function assertTiles(ctx: Ctx, spec: DashboardSpec): Promise<void> {
  for (const id of dependenciesOf(spec)) await authorize(ctx, 'view', id)
}

const emptyTile = (patch: Partial<DashboardTileData>): DashboardTileData => ({
  spec: null,
  result: null,
  metric: null,
  error: null,
  message: null,
  ...patch,
})

/**
 * Дашборды (06-analytics-engine.md §9): сетка плиток и глобальные фильтры;
 * данные плиток — одним запросом, каждая плитка — с правами смотрящего.
 */
export const DashboardService = {
  async create(tx: Executor, ctx: Ctx, input: DashboardCreateInput): Promise<string> {
    await assertTiles(ctx, input.spec)
    const object = await ObjectService.create(tx, ctx, {
      type: 'dashboard',
      spaceId: input.spaceId,
      parentId: input.parentId ?? null,
      title: input.name,
      meta: { tiles: input.spec.tiles.length },
    })
    await tx.insert(dashboards).values({
      id: object.id,
      spec: input.spec as unknown as Record<string, unknown>,
      refreshInterval: input.spec.refreshInterval,
      theme: input.spec.theme,
    })
    await LinkService.setDependencies(tx, object.id, dependenciesOf(input.spec))
    return object.id
  },

  async get(id: string, executor: Executor = db()): Promise<DashboardRecord> {
    const [row] = await executor
      .select({ dashboard: dashboards, object: objects })
      .from(dashboards)
      .innerJoin(objects, eq(objects.id, dashboards.id))
      .where(eq(dashboards.id, id))
      .limit(1)
    if (!row?.object.spaceId) throw errors.notFound('Дашборд')
    return {
      id,
      name: row.object.title,
      spaceId: row.object.spaceId,
      parentId: row.object.parentId,
      spec: row.dashboard.spec as unknown as DashboardSpec,
      version: row.object.version,
    }
  },

  async update(tx: Executor, ctx: Ctx, id: string, input: DashboardUpdateInput): Promise<void> {
    const changed: string[] = []
    if (input.name !== undefined) {
      await ObjectService.update(tx, ctx, id, { title: input.name })
      changed.push('name')
    }
    if (input.spec) {
      await assertTiles(ctx, input.spec)
      await tx
        .update(dashboards)
        .set({
          spec: input.spec as unknown as Record<string, unknown>,
          refreshInterval: input.spec.refreshInterval,
          theme: input.spec.theme,
        })
        .where(eq(dashboards.id, id))
      await LinkService.setDependencies(tx, id, dependenciesOf(input.spec))
      await ObjectService.update(
        tx,
        ctx,
        id,
        { meta: { tiles: input.spec.tiles.length }, mergeMeta: true },
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
      type: 'dashboard.updated',
      object: { id, type: 'dashboard', spaceId: object?.spaceId ?? null, title: object?.title },
      payload: { changed },
    })
  },

  /**
   * Данные плиток: фильтры дашборда — по привязкам плиток; плитка без доступа к
   * графику или данным — `no_access` (права по ссылкам не наследуются).
   */
  async data(ctx: Ctx, id: string, input: DashboardDataInput): Promise<DashboardData> {
    const dashboard = await DashboardService.get(id)
    const wanted = input.tiles ? new Set(input.tiles) : null
    const tiles = dashboard.spec.tiles.filter(
      (tile) => DATA_TILES.has(tile.kind) && (!wanted || wanted.has(tile.id)),
    )
    const entries = await Promise.all(
      tiles.map(async (tile): Promise<[string, DashboardTileData]> => {
        let spec: ChartSpec | null = null
        try {
          if (tile.kind === 'metric') {
            if (!tile.metricId) return [tile.id, emptyTile({ error: 'unsupported' })]
            // Права на показатель не открывают данные: значение — с политиками смотрящего
            await authorize(ctx, 'view', tile.metricId)
            const metric = await MetricService.get(tile.metricId)
            const value = await MetricService.tileValue(
              ctx,
              metric,
              tile,
              dashboard.spec.filters,
              input.filters,
            )
            return [tile.id, emptyTile({ metric: value })]
          }
          if (tile.chartId) {
            await authorize(ctx, 'view', tile.chartId)
            spec = (await ChartService.get(tile.chartId)).spec
          } else if (tile.spec) {
            spec = tile.spec
          } else {
            return [tile.id, emptyTile({ error: 'unsupported' })]
          }
          const result = await runChartSpec(ctx, spec, {}, (query) =>
            applyDashboardFilters(
              query,
              dashboard.spec.filters,
              tile.filterBindings,
              input.filters,
            ),
          )
          return [tile.id, emptyTile({ spec, result })]
        } catch (error) {
          if (isAppError(error) && (error.status === 403 || error.status === 404)) {
            return [tile.id, emptyTile({ error: 'no_access' })]
          }
          if (isAppError(error) && error.status < 500) {
            return [tile.id, emptyTile({ spec, error: 'failed', message: error.message })]
          }
          logger().error(
            { err: error, dashboardId: id, tileId: tile.id },
            'плитка дашборда не построена',
          )
          return [tile.id, emptyTile({ spec, error: 'failed' })]
        }
      }),
    )
    return { tiles: Object.fromEntries(entries) }
  },

  /**
   * Запрос плитки-графика с фильтрами дашборда по её привязкам — как у данных
   * плиток; для детализации и выгрузки. Только графики по датасету (`query`).
   */
  async tileQuery(
    ctx: Ctx,
    id: string,
    tileId: string,
    filters: Record<string, unknown>,
    unsupported: string,
  ): Promise<{ query: QuerySpec; title: string }> {
    const dashboard = await DashboardService.get(id)
    const tile = dashboard.spec.tiles.find((item) => item.id === tileId)
    if (tile?.kind !== 'chart') throw errors.notFound('Плитка')
    let spec: ChartSpec
    let title = tile.title ?? dashboard.name
    if (tile.chartId) {
      await authorize(ctx, 'view', tile.chartId)
      const chart = await ChartService.get(tile.chartId)
      spec = chart.spec
      title = tile.title ?? chart.name
    } else if (tile.spec) {
      spec = tile.spec
    } else {
      throw errors.validation('У плитки нет графика')
    }
    const query = 'query' in spec.data ? spec.data.query : null
    if (!query) throw errors.validation(unsupported)
    return {
      query: applyDashboardFilters(query, dashboard.spec.filters, tile.filterBindings, filters),
      title,
    }
  },

  /**
   * Детализация плитки до строк: запрос графика с фильтрами дашборда по
   * привязкам плитки, выбранный элемент — условия по разрезам (drill.ts);
   * строки — с политиками смотрящего, как в таблице датасета.
   */
  async drill(ctx: Ctx, id: string, input: DashboardDrillInput): Promise<DashboardDrillResult> {
    const { query: filtered } = await DashboardService.tileQuery(
      ctx,
      id,
      input.tileId,
      input.filters,
      'Детализация до строк доступна для графиков по датасету',
    )
    const plan = drillSpec(filtered, input.pick, input.limit)
    const result = await QueryService.run(ctx, plan.spec, { rowMeta: true, count: true })
    return { datasetId: plan.datasetId, result }
  },
}
