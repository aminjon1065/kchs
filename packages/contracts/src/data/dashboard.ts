import { z } from 'zod'
import type { FilterNode } from '../common/filter.js'
import { LangText, Uuid } from '../common/primitives.js'
import { MapCamera } from '../gis/map.js'
import { ChartSpec } from './chart.js'
import { MetricComparison, MetricPeriod, MetricValue } from './metric.js'
import { FieldRef, QueryResult } from './query.js'

/**
 * Дашборд (06-analytics-engine.md §9): сетка 12 колонок, плитки, глобальные
 * фильтры с привязкой к полям плиток. Объект реестра типа `dashboard`.
 */
export const DASHBOARD_COLUMNS = 12

export const TILE_KINDS = ['chart', 'metric', 'text', 'heading', 'filter', 'table', 'map'] as const
export const TileKind = z.enum(TILE_KINDS)

/** Плитка-показатель: свой период и сравнение вместо заданных в показателе. */
export const MetricTileOptions = z.object({
  /** null — всё время; не задан — период показателя. */
  period: MetricPeriod.nullable().optional(),
  comparison: MetricComparison.optional(),
})
export type MetricTileOptions = z.infer<typeof MetricTileOptions>

/**
 * Плитка-карта (ADR-0074): сохранённая карта со своим видом. Фильтры дашборда
 * привязываются к полям датасетов слоёв карты: условие уходит тайлам всех слоёв
 * этого датасета (параметр `f`), политики строк смотрящего добавляет сервер.
 */
export const MapTileOptions = z.object({
  /** Вид плитки; null — вид, сохранённый в карте. */
  camera: MapCamera.nullable().default(null),
  /** Id фильтра дашборда → id датасета слоя → поле датасета. */
  bindings: z.record(z.string(), z.record(Uuid, FieldRef)).default({}),
})
export type MapTileOptions = z.infer<typeof MapTileOptions>

const TileLayout = z.object({
  x: z
    .number()
    .int()
    .min(0)
    .max(DASHBOARD_COLUMNS - 1),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(DASHBOARD_COLUMNS),
  h: z.number().int().min(1).max(40),
})

export const DashboardTile = z
  .object({
    id: z.string().min(1).max(40),
    kind: TileKind,
    title: z.string().max(200).nullable().optional(),
    /** Плитка-график: сохранённый график… */
    chartId: Uuid.optional(),
    /** …или встроенная спецификация (запрос — внутри `spec.data.query`). */
    spec: ChartSpec.optional(),
    metricId: Uuid.optional(),
    metric: MetricTileOptions.optional(),
    /** Плитка-карта: сохранённая карта, её вид и привязка фильтров к слоям. */
    mapId: Uuid.optional(),
    map: MapTileOptions.optional(),
    /** Текст и заголовок — Markdown без HTML. */
    text: z.string().max(5000).optional(),
    /** Привязка глобальных фильтров: id фильтра → поле источника плитки. */
    filterBindings: z.record(z.string(), FieldRef).default({}),
  })
  .and(TileLayout)
export type DashboardTile = z.infer<typeof DashboardTile>

export const DASHBOARD_FILTER_KINDS = ['period', 'territory', 'unit', 'select', 'text'] as const

export const DashboardFilter = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(DASHBOARD_FILTER_KINDS),
  label: LangText,
  /** Значение по умолчанию; макросы: @my_territories, @my_unit, относительный период. */
  default: z.unknown().optional(),
  /** Для select: откуда брать значения. */
  source: z.object({ datasetId: Uuid, field: z.string() }).optional(),
})
export type DashboardFilter = z.infer<typeof DashboardFilter>

// ─── Фильтры дашборда → условия ──────────────────────────────────────────────

const isEmptyValue = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === '' ||
  (Array.isArray(value) && value.length === 0)

/**
 * Условие глобального фильтра дашборда над полем источника; пустое значение —
 * без условия. Одна функция для сервера (данные плиток, показатели) и клиента
 * (тайлы плитки-карты, ADR-0074).
 */
export function dashboardFilterCondition(
  filter: DashboardFilter,
  field: string,
  value: unknown,
): FilterNode | null {
  if (isEmptyValue(value)) return null
  switch (filter.kind) {
    case 'period':
      if (Array.isArray(value) && value.length === 2) return { field, op: 'between', value }
      if (typeof value === 'object' && value !== null && 'unit' in value) {
        return { field, op: 'relative', value }
      }
      return null
    case 'select':
    case 'unit':
      return Array.isArray(value) ? { field, op: 'in', value } : { field, op: 'eq', value }
    case 'text':
      return typeof value === 'string' ? { field, op: 'contains', value } : null
    case 'territory':
      if (typeof value === 'object' && value !== null && 'id' in value) {
        return { field, op: 'within', value }
      }
      return Array.isArray(value) ? { field, op: 'in', value } : { field, op: 'eq', value }
  }
}

/**
 * Условия глобальных фильтров по привязкам (id фильтра → поле): фильтр без
 * привязки не действует; значение не задано — значение по умолчанию фильтра.
 */
export function dashboardFiltersWhere(
  filters: readonly DashboardFilter[],
  bindings: Readonly<Record<string, string>>,
  values: Readonly<Record<string, unknown>>,
): FilterNode | null {
  const conditions = filters.flatMap((filter) => {
    const field = bindings[filter.id]
    if (!field) return []
    const value = filter.id in values ? values[filter.id] : filter.default
    const condition = dashboardFilterCondition(filter, field, value)
    return condition ? [condition] : []
  })
  if (conditions.length === 0) return null
  return conditions.length === 1 ? (conditions[0] as FilterNode) : { and: conditions }
}

/**
 * Плитка-карта: условие фильтров дашборда для каждого датасета, к полям
 * которого привязан хотя бы один фильтр (id датасета → FilterNode). Клиент
 * отдаёт его тайлам слоёв этого датасета параметром `f`.
 */
export function dashboardMapFilters(
  filters: readonly DashboardFilter[],
  options: Pick<MapTileOptions, 'bindings'> | undefined,
  values: Readonly<Record<string, unknown>>,
): Record<string, FilterNode> {
  const byDataset = new Map<string, Record<string, string>>()
  for (const [filterId, fields] of Object.entries(options?.bindings ?? {})) {
    for (const [datasetId, field] of Object.entries(fields)) {
      const bindings = byDataset.get(datasetId) ?? {}
      bindings[filterId] = field
      byDataset.set(datasetId, bindings)
    }
  }
  const out: Record<string, FilterNode> = {}
  for (const [datasetId, bindings] of byDataset) {
    const where = dashboardFiltersWhere(filters, bindings, values)
    if (where) out[datasetId] = where
  }
  return out
}

export const DashboardSpec = z.object({
  tiles: z.array(DashboardTile).max(60).default([]),
  filters: z.array(DashboardFilter).max(12).default([]),
  /** Автообновление, секунд; null — вручную и по новой версии данных. */
  refreshInterval: z.number().int().min(30).max(86_400).nullable().default(null),
  theme: z.enum(['auto', 'dark']).default('auto'),
})
export type DashboardSpec = z.infer<typeof DashboardSpec>

export const DashboardRecord = z.object({
  id: Uuid,
  name: z.string(),
  spaceId: Uuid,
  parentId: Uuid.nullable(),
  spec: DashboardSpec,
  version: z.number().int(),
})
export type DashboardRecord = z.infer<typeof DashboardRecord>

export const DashboardCreateInput = z.object({
  name: z.string().trim().min(1).max(200),
  spaceId: Uuid,
  parentId: Uuid.nullable().optional(),
  spec: DashboardSpec.default({ tiles: [], filters: [], refreshInterval: null, theme: 'auto' }),
})
export type DashboardCreateInput = z.infer<typeof DashboardCreateInput>

export const DashboardUpdateInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  spec: DashboardSpec.optional(),
})
export type DashboardUpdateInput = z.infer<typeof DashboardUpdateInput>

/** Данные плиток одним запросом: значения глобальных фильтров по их id. */
export const DashboardDataInput = z.object({
  filters: z.record(z.string(), z.unknown()).default({}),
  /** Только эти плитки (обновление одной плитки); без списка — все. */
  tiles: z.array(z.string()).max(60).optional(),
})
export type DashboardDataInput = z.infer<typeof DashboardDataInput>

/**
 * Данные плитки. `no_access` — нет доступа к графику или его данным: ссылочные
 * отношения права не наследуют (03-access-model.md), плитка показывает «нет доступа».
 */
export const DASHBOARD_TILE_ERRORS = ['no_access', 'failed', 'unsupported'] as const
export const DashboardTileData = z.object({
  spec: ChartSpec.nullable(),
  result: QueryResult.nullable(),
  /** Плитка-показатель: значение, сравнение, статус порога, история. */
  metric: MetricValue.nullable(),
  error: z.enum(DASHBOARD_TILE_ERRORS).nullable(),
  message: z.string().nullable(),
})
export type DashboardTileData = z.infer<typeof DashboardTileData>

export const DashboardData = z.object({
  tiles: z.record(z.string(), DashboardTileData),
})
export type DashboardData = z.infer<typeof DashboardData>

/** Выбранный элемент графика: условие по полю результата (как `ChartPick.filters`). */
export const DashboardDrillPick = z.object({
  field: z.string().min(1).max(128),
  op: z.enum(['eq', 'in', 'not_in', 'between']),
  value: z.unknown(),
})
export type DashboardDrillPick = z.infer<typeof DashboardDrillPick>

/**
 * Детализация плитки до строк: фильтры дашборда (как у данных плиток) и
 * выбранный элемент графика; строки — с политиками смотрящего.
 */
export const DashboardDrillInput = z.object({
  tileId: z.string().min(1).max(64),
  filters: z.record(z.string(), z.unknown()).default({}),
  pick: z.array(DashboardDrillPick).max(8).default([]),
  limit: z.number().int().min(1).max(1000).default(200),
})
export type DashboardDrillInput = z.infer<typeof DashboardDrillInput>

export const DashboardDrillResult = z.object({
  /** Датасет строк — «Открыть датасет». */
  datasetId: Uuid,
  /** Строки с `_id` и `_ver`, счётчик — всех строк под условиями. */
  result: QueryResult,
})
export type DashboardDrillResult = z.infer<typeof DashboardDrillResult>
