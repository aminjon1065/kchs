import type {
  DatasetRecord,
  FilterNode,
  LayerRecord,
  LayerStats,
  LayerStyle,
  LayerTilePreview,
  Locale,
} from '@kchs/contracts'
import {
  type CompiledLayerStyle,
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
import { queryOptions, useQueries, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { http } from '~/shared/api/client.js'
import { datasetQuery } from '../data/queries.js'
import type { DeckEntry } from './studio/deck-overlay.js'
import { deckDrawable } from './studio/deck-roles.js'
import { selectionLayers } from './studio/selection-layers.js'
import {
  base64urlJson,
  type StatsRequest,
  statsRequests,
  tilePreviewOf,
} from './style-editor/model.js'

/** Слой карты к отрисовке: запись слоя, видимость и прозрачность на этой карте. */
export interface RenderEntry {
  layer: LayerRecord
  visible: boolean
  opacity: number
  /**
   * Рабочая копия стиля из редактора (ADR-0075): рисуется вместо сохранённого,
   * тайлы — с предпросмотром `p`, если она меняет поля, фильтр или кластеры.
   */
  style?: LayerStyle | null
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
  /** Слои, отданные deck.gl (ADR-0110): их MapLibre не рисует. */
  deck: DeckEntry[]
}

/** Слои, объекты которых выбираются щелчком (кластер — приближение к нему). */
const CLICKABLE = new Set(['fill', 'line', 'point', 'cluster'])
/** Тайлы крупнее не запрашиваются — дальше MapLibre растягивает z16. */
const TILE_MAX_ZOOM = 16

export const layerSourceId = (layerId: string) => `layer-${layerId}`

/**
 * Статистика поля слоя с сервера (ADR-0075): агрегаты по всем строкам слоя с
 * политиками смотрящего; ключ — версия данных и запрос (поле, метод, фильтр).
 */
export const layerStatsQuery = (layer: LayerRecord, request: StatsRequest) =>
  queryOptions({
    queryKey: ['layer', layer.id, 'stats', layer.datasetVersion, request] as const,
    queryFn: () => http.post<LayerStats>(`/gis/layers/${layer.id}/stats`, request),
    staleTime: 5 * 60_000,
    retry: false,
    // Смена метода или числа классов — прежние границы того же поля, пока не пришли
    // новые: легенда не мигает «классы появятся»; другое поле или слой — без них
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === layer.id &&
      (previousQuery.queryKey[4] as StatsRequest | undefined)?.field === request.field
        ? previous
        : undefined,
  })

/** Статистика поля слоя для формы стиля; без запроса (ручные границы) — не запрашивается. */
export function useLayerFieldStats(layer: LayerRecord, request: StatsRequest | null) {
  const fallback: StatsRequest = {
    field: '',
    normalizeBy: null,
    method: null,
    classes: 5,
    filter: null,
  }
  return useQuery({ ...layerStatsQuery(layer, request ?? fallback), enabled: request !== null })
}

interface LayerStatsView {
  breaks: number[] | null
  domains: Record<string, FieldDomain>
}

const domainOf = (stats: LayerStats): FieldDomain | null =>
  stats.min === null || stats.max === null
    ? null
    : { min: stats.min, max: stats.max, nulls: stats.nulls }

/**
 * Адрес тайлов слоя: версия данных и слоя — в адресе (кэш браузера), фильтр и
 * время — условия, предпросмотр — рабочая копия стиля из редактора.
 */
export function layerTileUrl(
  layer: LayerRecord,
  options: {
    filter?: FilterNode | null
    time?: string | null
    preview?: LayerTilePreview | null
  } = {},
): string {
  const query = new URLSearchParams({ v: String(layer.datasetVersion), lv: String(layer.version) })
  if (options.filter) query.set('f', base64urlJson(options.filter))
  if (options.time) query.set('t', options.time)
  if (options.preview) query.set('p', base64urlJson(options.preview))
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
    /**
     * Порог числа объектов, с которого слой рисует deck.gl (ADR-0110).
     * null — deck.gl выключен или недоступен: всё рисует MapLibre.
     */
    deckThreshold?: number | null
  } = {},
): RenderedLayers {
  const locale = useAppearance((s) => s.locale) as Locale
  const drawn = entries.filter((entry) => entry.layer.dataAccess)
  const datasets = useQueries({
    queries: drawn.map((entry) => datasetQuery(entry.layer.datasetId)),
  })
  const stats = useLayerStats(drawn)
  const datasetVersions = datasets.map((query) => query.dataUpdatedAt).join(',')

  // biome-ignore lint/correctness/useExhaustiveDependencies: результаты запросов — по отметкам обновления
  return useMemo(() => {
    const sources: Record<string, SourceSpecification> = {}
    const layers: LayerSpecification[] = []
    const images = new Map<string, MapImageRequest>()
    const legends = new Map<string, LegendModel>()
    const warnings = new Map<string, StyleWarning[]>()
    const interactive: string[] = []
    const deck: DeckEntry[] = []
    if (!theme) {
      return {
        sources,
        layers,
        images: [],
        legends,
        warnings,
        interactive,
        sourceOf: layerSourceId,
        deck,
      }
    }
    drawn.forEach((entry, index) => {
      const { layer } = entry
      const style = entry.style ?? layer.style
      const source = layerSourceId(layer.id)
      const layerStats = stats.views[index]
      let compiled: CompiledLayerStyle
      try {
        compiled = compileLayerStyle(
          { ...style, opacity: style.opacity * entry.opacity },
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
      const tiles = layerTileUrl(layer, {
        filter: options.filters?.[layer.id] ?? null,
        // Интервал — только слоям со временем (у рабочей копии — её поле времени):
        // у остальных адрес тайлов не меняется
        time: style.time ? options.time : null,
        preview: tilePreviewOf(layer.style, entry.style),
      })
      // Большой набор рисует deck.gl по тем же тайлам (ADR-0110)
      const threshold = options.deckThreshold
      if (
        threshold !== null &&
        threshold !== undefined &&
        layer.featureCount >= threshold &&
        deckDrawable(compiled.layers)
      ) {
        deck.push({
          layerId: layer.id,
          tileUrl: tiles,
          style: compiled.layers,
          maxZoom: TILE_MAX_ZOOM,
        })
        return
      }
      sources[source] = {
        type: 'vector',
        tiles: [tiles],
        minzoom: 0,
        maxzoom: TILE_MAX_ZOOM,
      }
      for (const image of compiled.images) images.set(image.id, image)
      for (const spec of compiled.layers) {
        layers.push(spec)
        const role = (spec.metadata as Record<string, unknown> | undefined)?.['kchs:role']
        if (typeof role === 'string' && CLICKABLE.has(role)) interactive.push(spec.id)
      }
      // Подсветка выделенных объектов — по feature-state (ADR-0073)
      layers.push(...selectionLayers(layer, source, theme))
    })
    return {
      sources,
      layers,
      images: [...images.values()],
      legends,
      warnings,
      interactive,
      sourceOf: layerSourceId,
      deck,
    }
  }, [
    // Версия данных — в адресе тайлов: правка объекта (ADR-0076) перерисовывает слой
    drawn
      .map(
        (entry) =>
          `${entry.layer.id}:${entry.layer.version}:${entry.layer.datasetVersion}:${entry.visible}:${
            entry.opacity
          }:${entry.style ? JSON.stringify(entry.style) : ''}`,
      )
      .join('|'),
    theme,
    locale,
    datasetVersions,
    stats.version,
    JSON.stringify(options.filters ?? {}),
    options.time,
    options.deckThreshold,
  ])
}

/**
 * Границы классов и диапазоны полей для стилей слоёв — статистика сервера по
 * всем строкам каждого слоя (с фильтром рабочей копии стиля). Пока границы не
 * пришли, компилятор рисует слой одним цветом и пишет в легенде «классы появятся».
 */
export function useLayerStats(entries: readonly RenderEntry[]): {
  views: LayerStatsView[]
  /** Отметка обновления — зависимость мемоизации у вызывающего. */
  version: string
} {
  const plan = entries.map((entry) => statsRequests(entry.style ?? entry.layer.style))
  const requests = plan.flatMap((need, index) => {
    const layer = entries[index]?.layer as LayerRecord
    return [
      ...(need.breaks ? [{ index, layer, request: need.breaks, breaks: true }] : []),
      ...need.domains.map((request) => ({ index, layer, request, breaks: false })),
    ]
  })
  const results = useQueries({
    queries: requests.map((item) => layerStatsQuery(item.layer, item.request)),
  })
  const views: LayerStatsView[] = entries.map(() => ({ breaks: null, domains: {} }))
  requests.forEach((item, i) => {
    const data = results[i]?.data
    const view = views[item.index]
    if (!data || !view) return
    const domain = domainOf(data)
    // Диапазон поля градуированного стиля — для «Нет данных» в легенде
    if (domain) view.domains[item.request.field] = domain
    if (item.breaks) view.breaks = data.breaks
  })
  // Отметка — сами границы и диапазоны: и новые данные, и прежние на время запроса
  return { views, version: JSON.stringify(views) }
}
