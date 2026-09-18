import { z } from 'zod'
import { LangText, Uuid } from '../common/primitives.js'
import { ChartSpec } from './chart.js'
import { FieldRef, QueryResult } from './query.js'

/**
 * Дашборд (06-analytics-engine.md §9): сетка 12 колонок, плитки, глобальные
 * фильтры с привязкой к полям плиток. Объект реестра типа `dashboard`.
 */
export const DASHBOARD_COLUMNS = 12

export const TILE_KINDS = ['chart', 'metric', 'text', 'heading', 'filter', 'table'] as const
export const TileKind = z.enum(TILE_KINDS)

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
  error: z.enum(DASHBOARD_TILE_ERRORS).nullable(),
  message: z.string().nullable(),
})
export type DashboardTileData = z.infer<typeof DashboardTileData>

export const DashboardData = z.object({
  tiles: z.record(z.string(), DashboardTileData),
})
export type DashboardData = z.infer<typeof DashboardData>
