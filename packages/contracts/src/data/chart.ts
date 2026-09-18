import { z } from 'zod'
import { LangText, Uuid } from '../common/primitives.js'
import { FieldFormat } from '../fields/field-def.js'
import { QuerySpec } from './query.js'

/**
 * ChartSpec v1 — contracts/chart-spec.md. Описание графика без привязки к
 * библиотеке; `packages/chart-spec` превращает его в опции ECharts. Цвета — только
 * имена палитр и семантические токены, никаких hex: конкретный цвет берёт тема.
 */
export const CHART_TYPES = [
  'table',
  'number',
  'bar',
  'line',
  'area',
  'pie',
  'donut',
  'scatter',
  'bubble',
  'heatmap',
  'histogram',
  'funnel',
  'gauge',
  'pivot',
  'map',
  'combo',
  'treemap',
] as const
export const ChartType = z.enum(CHART_TYPES)
export type ChartType = z.infer<typeof ChartType>

export const ChannelType = z.enum(['quantitative', 'temporal', 'nominal', 'ordinal'])
export type ChannelType = z.infer<typeof ChannelType>

export const PALETTES = ['categorical', 'sequential', 'diverging'] as const

/** Семантические цвета из дизайн-системы. */
export const CHART_COLOR_TOKENS = [
  'accent',
  'success',
  'warning',
  'danger',
  'info',
  'neutral',
  'purple',
] as const
export const ChartColorToken = z.enum(CHART_COLOR_TOKENS)

export const Channel = z.object({
  field: z.string().min(1),
  type: ChannelType,
  label: LangText.optional(),
  format: FieldFormat.optional(),
})
export type Channel = z.infer<typeof Channel>

export const YChannel = Channel.extend({
  axis: z.enum(['left', 'right']).default('left'),
  /** Для combo: как рисовать серию. */
  mark: z.enum(['bar', 'line', 'area']).optional(),
  color: ChartColorToken.optional(),
})
export type YChannel = z.infer<typeof YChannel>

export const ColorChannel = z.union([
  Channel.extend({ palette: z.enum(PALETTES).default('categorical') }),
  z.object({ value: ChartColorToken }),
])

export const ChartEncoding = z.object({
  x: Channel.nullable().optional(),
  y: z.array(YChannel).default([]),
  color: ColorChannel.nullable().optional(),
  size: Channel.nullable().optional(),
  shape: Channel.nullable().optional(),
  tooltip: z.array(z.string()).default([]),
  facet: Channel.nullable().optional(),
  text: Channel.nullable().optional(),
})
export type ChartEncoding = z.infer<typeof ChartEncoding>

const AxisOptions = z.object({
  grid: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  unit: z.string().max(32).optional(),
  label: LangText.optional(),
  log: z.boolean().optional(),
})

export const ChartOptions = z.object({
  stacked: z.boolean().default(false),
  /** Доли вместо значений (bar/area со стеком). */
  percent: z.boolean().default(false),
  horizontal: z.boolean().default(false),
  smooth: z.boolean().default(false),
  area: z.boolean().default(false),
  points: z.enum(['auto', 'always', 'never']).default('auto'),
  legend: z
    .object({
      show: z.boolean().default(true),
      position: z.enum(['top', 'bottom', 'left', 'right']).default('bottom'),
    })
    .default({ show: true, position: 'bottom' }),
  axes: z
    .object({ x: AxisOptions.optional(), y: AxisOptions.optional(), y2: AxisOptions.optional() })
    .default({}),
  referenceLines: z
    .array(
      z.object({
        axis: z.enum(['x', 'y']),
        value: z.union([z.number(), z.string()]),
        label: z.string().max(120).optional(),
        style: z.enum(['solid', 'dashed', 'dotted']).default('dashed'),
        color: ChartColorToken.default('danger'),
      }),
    )
    .default([]),
  annotations: z
    .array(z.object({ x: z.union([z.string(), z.number()]), text: z.string().max(200) }))
    .default([]),
  comparison: z
    .object({ mode: z.enum(['previous_period', 'previous_year', 'target']) })
    .nullable()
    .optional(),
  sort: z
    .object({ by: z.string(), dir: z.enum(['asc', 'desc']).default('desc') })
    .nullable()
    .optional(),
  /** Top-N категорий; остальное — «прочее», если `other`. */
  limit: z.number().int().min(1).max(5000).nullable().optional(),
  other: z.boolean().default(false),
  labels: z
    .object({ show: z.enum(['auto', 'always', 'never']).default('auto') })
    .default({ show: 'auto' }),
  zoom: z.boolean().default(false),
  brush: z.boolean().default(false),
  /** Для number/gauge: цель и пороги (если не из показателя). */
  target: z.number().nullable().optional(),
  thresholds: z.array(z.object({ value: z.number(), color: ChartColorToken })).default([]),
})
export type ChartOptions = z.infer<typeof ChartOptions>

export const ChartInteractions = z.object({
  click: z
    .object({
      action: z.enum(['drill', 'filter', 'open']),
      target: z.object({ kind: z.enum(['table', 'map', 'object', 'dashboard']) }).optional(),
    })
    .nullable()
    .optional(),
  brush: z
    .object({ action: z.literal('filter') })
    .nullable()
    .optional(),
})

export const ChartData = z.union([
  z.object({ queryId: Uuid }),
  z.object({ query: QuerySpec }),
  z.object({ metricId: Uuid }),
])
export type ChartData = z.infer<typeof ChartData>

export const ChartSpec = z.object({
  version: z.literal(1),
  type: ChartType,
  data: ChartData,
  encoding: ChartEncoding,
  options: ChartOptions.default(ChartOptions.parse({})),
  interactions: ChartInteractions.default({}),
  theme: z.enum(['auto', 'light', 'dark']).default('auto'),
})
export type ChartSpec = z.infer<typeof ChartSpec>

/** Объект реестра «график»: спецификация и параметры по умолчанию. */
export const ChartRecord = z.object({
  id: Uuid,
  name: z.string(),
  spaceId: Uuid,
  parentId: Uuid.nullable(),
  spec: ChartSpec,
  paramsDefaults: z.record(z.string(), z.unknown()).default({}),
})
export type ChartRecord = z.infer<typeof ChartRecord>

export const ChartCreateInput = z.object({
  name: z.string().trim().min(1).max(200),
  spaceId: Uuid,
  parentId: Uuid.nullable().optional(),
  spec: ChartSpec,
})
export type ChartCreateInput = z.infer<typeof ChartCreateInput>
