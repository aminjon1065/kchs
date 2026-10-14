import type {
  ChartSpec,
  DashboardTile,
  MetricDefinition,
  NotebookCell,
  PipelineDefinition,
  QueryResult,
  QuerySpec,
} from '@kchs/contracts'
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import { ApiError } from '~/shared/api/errors.js'
import { dataKeys } from './queries.js'

/**
 * Запросы «Исследования» (ADR-0217): результат плана, профили полей обзора без
 * шторма запросов, перенос результата в тетрадь и на дашборд, разбор ошибок.
 */

/** Результат QuerySpec: ключ — сама спецификация, кэш общий у экрана, итогов и строк. */
/** Ячейка-запрос тетради — как её добавляет «Исследование». */
export type QueryCell = Extract<NotebookCell, { kind: 'query' }>

export const exploreRunQuery = (scope: string, spec: QuerySpec, enabled = true) =>
  queryOptions({
    queryKey: ['explore', scope, JSON.stringify(spec)],
    queryFn: (): Promise<QueryResult> => http.post('/queries/run', { body: { spec } }),
    placeholderData: keepPreviousData,
    retry: false,
    enabled,
  })

/** Не больше трёх профилей одновременно: профиль — отдельный проход по таблице датасета. */
const PROFILE_CONCURRENCY = 3
let running = 0
const waiting: Array<() => void> = []

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= PROFILE_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve))
  running += 1
  try {
    return await task()
  } finally {
    running -= 1
    waiting.shift()?.()
  }
}

/** Профиль поля — тот же ключ кэша, что у вкладки «Схема», но с ограничением параллельности. */
export const overviewProfileQuery = (datasetId: string, key: string, enabled: boolean) =>
  queryOptions({
    queryKey: dataKeys.profile(datasetId, key),
    queryFn: () =>
      limited(() =>
        http.get('/datasets/:id/fields/:key/profile', { params: { id: datasetId, key } }),
      ),
    staleTime: 60_000,
    retry: false,
    enabled,
  })

export const exploreApi = {
  /** Новая тетрадь с ячейкой-запросом в пространстве датасета. */
  createNotebook: async (name: string, spaceId: string, cell: QueryCell) => {
    const created = await http.post('/notebooks', { body: { name, spaceId, cells: [cell] } })
    return { id: created.id, title: name }
  },
  /** Ячейка-запрос в конец тетради — сразу видна всем, кто её открыл. */
  addToNotebook: async (id: string, cell: QueryCell) => {
    const notebook = await http.post('/notebooks/:id/cells', {
      params: { id },
      body: { cells: [cell] },
    })
    return { id: notebook.id, title: notebook.name }
  },
  /** Плитка-график под всеми плитками дашборда, на половину ширины сетки. */
  addDashboardTile: async (id: string, title: string, spec: ChartSpec, tileId: string) => {
    const dashboard = await http.get('/dashboards/:id', { params: { id } })
    const bottom = dashboard.spec.tiles.reduce((max, tile) => Math.max(max, tile.y + tile.h), 0)
    const tile: DashboardTile = {
      id: tileId,
      kind: 'chart',
      title,
      spec,
      filterBindings: {},
      x: 0,
      y: bottom,
      w: 6,
      h: 8,
    }
    await http.patch('/dashboards/:id', {
      params: { id },
      body: { spec: { ...dashboard.spec, tiles: [...dashboard.spec.tiles, tile] } },
    })
    return { id, title: dashboard.name }
  },
  /** Сохранённый график из результата. */
  saveChart: (name: string, spaceId: string, spec: ChartSpec) =>
    http.post('/charts', { body: { name, spaceId, spec } }),
  /** Пайплайн из плана и его первый прогон: прогон создаёт датасет-результат. */
  saveAsDataset: async (name: string, spaceId: string, definition: PipelineDefinition) => {
    const pipeline = await http.post('/pipelines', { body: { name, spaceId, definition } })
    await http.post('/pipelines/:id/run', { params: { id: pipeline.id } })
    return { id: pipeline.id }
  },
  /** Показатель из меры плана над датасетом исследования. */
  saveAsMetric: (name: string, spaceId: string, datasetId: string, definition: MetricDefinition) =>
    http.post('/metrics', { body: { name, spaceId, datasetId, definition } }),
}

/** Ошибка запроса для показа: вид, текст сервера; без клиента API в компонентах. */
export interface ExploreFailure {
  kind: 'timeout' | 'forbidden' | 'invalid' | 'other'
  message: string | null
}

export function exploreFailure(error: unknown): ExploreFailure {
  if (!(error instanceof ApiError)) return { kind: 'other', message: null }
  if (error.code === 'query_timeout') return { kind: 'timeout', message: error.message }
  if (error.status === 403) return { kind: 'forbidden', message: error.message }
  if (error.status === 400 || error.status === 422)
    return { kind: 'invalid', message: error.message }
  return { kind: 'other', message: error.message }
}
