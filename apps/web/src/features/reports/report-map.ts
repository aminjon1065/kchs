import type { Bbox, LayerRecord, MapCamera } from '@kchs/contracts'
import type { LegendModel, MapTheme } from '@kchs/map-style'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { type BasemapStyle, useBasemapStyle } from '~/features/gis/basemaps.js'
import {
  type RenderEntry,
  type RenderedLayers,
  useRenderedLayers,
} from '~/features/gis/layer-render.js'
import { layerQuery, mapQuery } from '~/features/gis/queries.js'
import { ApiError } from '~/shared/api/client.js'

/** Вид по умолчанию — Таджикистан целиком (как у новой карты). */
export const DEFAULT_REPORT_CAMERA: MapCamera = {
  center: [69, 38.6],
  zoom: 6,
  bearing: 0,
  pitch: 0,
}

export interface ReportMapSource {
  source: 'map' | 'layer'
  mapId: string | null
  layerId: string | null
  camera: MapCamera | null
}

export interface ReportMapState {
  /** Источник не выбран. */
  missing: boolean
  /** Нет доступа к карте или слою (или удалены). */
  denied: boolean
  loading: boolean
  rendered: RenderedLayers
  basemapStyle: BasemapStyle | null
  /** Вид блока, иначе вид карты; у слоя без вида — охват его данных. */
  camera: MapCamera
  fit: Bbox | null
  legends: LegendModel[]
  /** Слои без доступа к данным: карта рисуется без них, отчёт об этом говорит. */
  hiddenLayers: number
  /** Атрибуция подложки текстом: на картинке карты её нет, а лицензия требует. */
  attribution: string[]
}

function unionBbox(boxes: Array<Bbox | null | undefined>): Bbox | null {
  let out: Bbox | null = null
  for (const box of boxes) {
    if (!box) continue
    out = out
      ? [
          Math.min(out[0], box[0]),
          Math.min(out[1], box[1]),
          Math.max(out[2], box[2]),
          Math.max(out[3], box[3]),
        ]
      : box
  }
  return out
}

/** Атрибуция источников стиля подложки без разметки. */
function attributionOf(style: BasemapStyle | null): string[] {
  const sources = (style?.sources ?? {}) as Record<string, { attribution?: unknown }>
  const out = new Set<string>()
  for (const source of Object.values(sources)) {
    if (typeof source.attribution !== 'string') continue
    const text = source.attribution
      .replace(/<[^>]*>/g, ' ')
      .replace(/&copy;/g, '©')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) out.add(text)
  }
  return [...out]
}

const denied = (error: unknown) =>
  error instanceof ApiError && (error.status === 403 || error.status === 404)

/**
 * Карта блока отчёта (ADR-0078): сохранённая карта (подложка, слои, вид) или
 * один слой на подложке по умолчанию. Слои и данные — с правами смотрящего:
 * в отчёте получателя его строки, слой без доступа не рисуется.
 */
export function useReportMap(block: ReportMapSource, theme: MapTheme | null): ReportMapState {
  const useMap = block.source === 'map'
  const map = useQuery({
    ...mapQuery(block.mapId ?? ''),
    enabled: useMap && Boolean(block.mapId),
    retry: false,
  })
  const layerIds = useMap
    ? (map.data?.spec.layers ?? []).map((entry) => entry.layerId)
    : block.layerId
      ? [block.layerId]
      : []
  const layers = useQueries({
    queries: layerIds.map((id) => ({ ...layerQuery(id), retry: false })),
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: слои — по отметкам обновления запросов
  const entries: RenderEntry[] = useMemo(() => {
    const out: RenderEntry[] = []
    layers.forEach((query, index) => {
      const layer = query.data as LayerRecord | undefined
      if (!layer) return
      const entry = useMap ? map.data?.spec.layers[index] : null
      out.push({
        layer,
        visible: entry ? entry.visible : true,
        opacity: entry ? entry.opacity : 1,
      })
    })
    return out
  }, [layers.map((query) => query.dataUpdatedAt).join(','), map.dataUpdatedAt, useMap])
  const rendered = useRenderedLayers(entries, theme, {
    time: map.data?.spec.time ? `${map.data.spec.time.from}/${map.data.spec.time.to}` : null,
  })
  // Адреса API в стиле уже перенесены на origin страницы печати (`rebaseApiUrls`)
  const basemap = useBasemapStyle(map.data?.spec.basemapId ?? null, theme?.mode ?? 'light')
  const basemapStyle = basemap.style

  const missing = useMap ? !block.mapId : !block.layerId
  const layerDenied = !useMap && layers[0]?.error ? denied(layers[0].error) : false
  const loading =
    !missing &&
    ((useMap && map.isLoading) ||
      layers.some((query) => query.isLoading) ||
      basemap.isLoading ||
      !theme)
  const camera = block.camera ?? (useMap ? map.data?.spec.camera : null) ?? DEFAULT_REPORT_CAMERA
  const fit =
    block.camera || useMap
      ? null
      : unionBbox(entries.map((entry) => (entry.layer.dataAccess ? entry.layer.extent : null)))
  const legends = entries
    .filter((entry) => entry.visible)
    .map((entry) => rendered.legends.get(entry.layer.id))
    .filter((legend): legend is LegendModel => Boolean(legend?.show))

  return {
    missing,
    denied: (useMap && map.error ? denied(map.error) : false) || layerDenied,
    loading,
    rendered,
    basemapStyle,
    camera,
    fit,
    legends,
    hiddenLayers:
      entries.filter((entry) => !entry.layer.dataAccess).length +
      layers.filter((query) => query.error).length,
    attribution: attributionOf(basemap.style),
  }
}
