import type {
  DatasetRecord,
  FilterNode,
  LayerRecord,
  LayerStyle,
  Locale,
  QueryResult,
} from '@kchs/contracts'
import {
  type CompiledLayerStyle,
  classify,
  compileLayerStyle,
  type FieldDomain,
  type LegendModel,
  type MapImageRequest,
  type MapTheme,
  type StyleField,
  type StyleWarning,
} from '@kchs/map-style'
import type {
  MapLayerSpecification as LayerSpecification,
  MapSourceSpecification as SourceSpecification,
} from '@kchs/ui'
import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { http } from '~/shared/api/client.js'
import { datasetQuery } from '../data/queries.js'

/** Слой карты к отрисовке: запись слоя, видимость и прозрачность на этой карте. */
export interface RenderEntry {
  layer: LayerRecord
  visible: boolean
  opacity: number
}

export interface RenderedLayers {
  sources: Record<string, SourceSpecification>
  layers: LayerSpecification[]
  images: MapImageRequest[]
  /** Легенда и замечания компилятора по идентификатору слоя. */
  legends: Map<string, LegendModel>
  warnings: Map<string, StyleWarning[]>
  /** Слои MapLibre, объекты которых выбираются щелчком. */
  interactive: string[]
  /** Источник MapLibre слоя — для выделения объектов (`feature-state`). */
  sourceOf: (layerId: string) => string
}

/** Выборка значений для классов и диапазонов: крупные слои — первые строки. */
const SAMPLE_ROWS = 5000
/** Слои, объекты которых выбираются щелчком (кластер — приближение к нему). */
const CLICKABLE = new Set(['fill', 'line', 'point', 'cluster'])
/** Тайлы крупнее не запрашиваются — дальше MapLibre растягивает z16. */
const TILE_MAX_ZOOM = 16

export const layerSourceId = (layerId: string) => `layer-${layerId}`

/** Числовые поля стиля, которым нужны границы классов или диапазон значений. */
function statsFields(style: LayerStyle): { breaks: string[] | null; domains: string[] } {
  const renderer = style.renderer
  const domains = new Set<string>()
  let breaks: string[] | null = null
  if (renderer.kind === 'graduated' && renderer.method !== 'manual') {
    breaks = renderer.normalizeBy ? [renderer.field, renderer.normalizeBy] : [renderer.field]
  }
  if (renderer.kind === 'proportional') domains.add(renderer.field)
  if (renderer.kind === 'heatmap' && renderer.weightField) domains.add(renderer.weightField)
  if (style.geometry === 'point' && style.point.sizeBy) domains.add(style.point.sizeBy.field)
  return { breaks, domains: [...domains] }
}

interface LayerStats {
  breaks: number[] | null
  domains: Record<string, FieldDomain>
}

/** Границы классов и диапазоны по выборке строк слоя — с политиками смотрящего. */
async function loadStats(layer: LayerRecord): Promise<LayerStats> {
  const need = statsFields(layer.style)
  const fields = [...new Set([...(need.breaks ?? []), ...need.domains])]
  if (fields.length === 0) return { breaks: null, domains: {} }
  const steps: unknown[] = []
  if (layer.style.filter) steps.push({ type: 'filter', where: layer.style.filter })
  steps.push({ type: 'select', fields }, { type: 'limit', limit: SAMPLE_ROWS })
  const result = await http.post<QueryResult>('/queries/run', {
    spec: { version: 1, source: { kind: 'dataset', id: layer.datasetId }, steps },
  })
  const column = (key: string) => {
    const index = result.fields.findIndex((field) => field.name === key)
    return result.rows.map((row) => {
      const value = row[index]
      return typeof value === 'number' ? value : value === null ? null : Number(value)
    })
  }
  const domains: Record<string, FieldDomain> = {}
  for (const key of need.domains) {
    const values = column(key).filter((value): value is number => Number.isFinite(value))
    if (values.length === 0) continue
    domains[key] = {
      min: Math.min(...values),
      max: Math.max(...values),
      nulls: column(key).length - values.length,
    }
  }
  let breaks: number[] | null = null
  const renderer = layer.style.renderer
  if (need.breaks && renderer.kind === 'graduated') {
    const values = column(renderer.field)
    const by = renderer.normalizeBy ? column(renderer.normalizeBy) : null
    const series = by
      ? values.map((value, index) => {
          const divisor = by[index]
          return value === null || !divisor ? null : value / divisor
        })
      : values
    breaks = classify(series, renderer.method, renderer.classes)
  }
  return { breaks, domains }
}

/** Адрес тайлов слоя: версия данных и слоя — в адресе (кэш браузера), фильтр и время — условия. */
export function layerTileUrl(
  layer: LayerRecord,
  options: { filter?: FilterNode | null; time?: string | null } = {},
): string {
  const query = new URLSearchParams({ v: String(layer.datasetVersion), lv: String(layer.version) })
  if (options.filter) {
    const json = JSON.stringify(options.filter)
    const bytes = new TextEncoder().encode(json)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    query.set('f', btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''))
  }
  if (options.time) query.set('t', options.time)
  // Шаблон {z}/{x}/{y} — без кодирования фигурных скобок
  return `${window.location.origin}/api/v1/gis/layers/${layer.id}/tiles/{z}/{x}/{y}.pbf?${query}`
}

const styleFieldsOf = (dataset: DatasetRecord | undefined): StyleField[] =>
  (dataset?.fields ?? []).map((field) => ({
    key: field.key,
    type: field.type,
    label: field.label,
    format: field.format ?? null,
    options: field.options ?? null,
  }))

/**
 * Слои карты → источники и слои MapLibre (07-gis-engine.md §4, ADR-0065, ADR-0072):
 * стиль каждого слоя компилирует `@kchs/map-style` с полями датасета и темой
 * дизайн-системы; прозрачность на карте умножает прозрачность стиля. Слой без
 * доступа к данным не рисуется — студия показывает его как «нет доступа».
 */
export function useRenderedLayers(
  entries: readonly RenderEntry[],
  theme: MapTheme | null,
  options: {
    /** Условия тайлов по слоям (связанные представления, дашборд): FilterNode по полям датасета. */
    filters?: Readonly<Record<string, FilterNode>>
    /** Интервал времени `from/to` для слоёв со временем. */
    time?: string | null
  } = {},
): RenderedLayers {
  const locale = useAppearance((s) => s.locale) as Locale
  const drawn = entries.filter((entry) => entry.layer.dataAccess)
  const datasets = useQueries({
    queries: drawn.map((entry) => datasetQuery(entry.layer.datasetId)),
  })
  const stats = useQueries({
    queries: drawn.map((entry) => ({
      queryKey: ['layer', entry.layer.id, 'stats', entry.layer.version, entry.layer.datasetVersion],
      queryFn: () => loadStats(entry.layer),
      staleTime: 5 * 60_000,
    })),
  })
  const datasetVersions = datasets.map((query) => query.dataUpdatedAt).join(',')
  const statsVersions = stats.map((query) => query.dataUpdatedAt).join(',')

  // biome-ignore lint/correctness/useExhaustiveDependencies: результаты запросов — по отметкам обновления
  return useMemo(() => {
    const sources: Record<string, SourceSpecification> = {}
    const layers: LayerSpecification[] = []
    const images = new Map<string, MapImageRequest>()
    const legends = new Map<string, LegendModel>()
    const warnings = new Map<string, StyleWarning[]>()
    const interactive: string[] = []
    if (!theme) {
      return {
        sources,
        layers,
        images: [],
        legends,
        warnings,
        interactive,
        sourceOf: layerSourceId,
      }
    }
    drawn.forEach((entry, index) => {
      const { layer } = entry
      const source = layerSourceId(layer.id)
      const layerStats = stats[index]?.data
      let compiled: CompiledLayerStyle
      try {
        compiled = compileLayerStyle(
          { ...layer.style, opacity: layer.style.opacity * entry.opacity },
          {
            id: layer.id,
            source,
            sourceLayer: 'layer',
            geometry: layer.geometryType,
            fields: styleFieldsOf(datasets[index]?.data),
            theme,
            locale,
            name: layer.name,
            breaks: layerStats?.breaks ?? null,
            domains: layerStats?.domains ?? {},
          },
        )
      } catch {
        return
      }
      legends.set(layer.id, compiled.legend)
      warnings.set(layer.id, compiled.warnings)
      if (!entry.visible) return
      sources[source] = {
        type: 'vector',
        tiles: [
          layerTileUrl(layer, { filter: options.filters?.[layer.id] ?? null, time: options.time }),
        ],
        minzoom: 0,
        maxzoom: TILE_MAX_ZOOM,
      }
      for (const image of compiled.images) images.set(image.id, image)
      for (const spec of compiled.layers) {
        layers.push(spec)
        const role = (spec.metadata as Record<string, unknown> | undefined)?.['kchs:role']
        if (typeof role === 'string' && CLICKABLE.has(role)) interactive.push(spec.id)
      }
    })
    return {
      sources,
      layers,
      images: [...images.values()],
      legends,
      warnings,
      interactive,
      sourceOf: layerSourceId,
    }
  }, [
    drawn
      .map((entry) => `${entry.layer.id}:${entry.layer.version}:${entry.visible}:${entry.opacity}`)
      .join('|'),
    theme,
    locale,
    datasetVersions,
    statsVersions,
    JSON.stringify(options.filters ?? {}),
    options.time,
  ])
}
