import type { MapInstance, MapLayerSpecification, MapSourceSpecification } from '@kchs/ui'
import { useEffect, useRef } from 'react'

/** Коллекция GeoJSON временной геометрии инструмента. */
export interface OverlayData {
  type: 'FeatureCollection'
  features: Array<{
    type: 'Feature'
    properties: Record<string, unknown>
    geometry: { type: string; coordinates: unknown }
  }>
}

export const EMPTY_OVERLAY: OverlayData = { type: 'FeatureCollection', features: [] }

/** Префикс источников и слоёв инструментов: `MapCanvas` их не трогает (у данных — `kchs-data:`). */
const PREFIX = 'kchs-tool:'

type GeoJsonSource = { setData: (data: OverlayData) => void }

/**
 * Временная геометрия инструмента поверх карты (измерение, найденная граница,
 * метка координат, ADR-0073): GeoJSON-источник и слои прямо на экземпляре
 * MapLibre, выше слоёв данных. Смена подложки (`setStyle`) переносит только
 * данные — слои инструмента добавляются заново по `style.load`.
 */
export function useToolOverlay(
  map: MapInstance | null,
  key: string,
  data: OverlayData,
  layers: (source: string) => MapLayerSpecification[],
  /** Смена оформления (тема) — слои строятся заново. */
  look = '',
): void {
  const source = `${PREFIX}${key}`
  const latest = useRef({ data, layers })
  latest.current = { data, layers }

  // biome-ignore lint/correctness/useExhaustiveDependencies: слои строятся заново при смене карты и оформления; данные — эффект ниже
  useEffect(() => {
    if (!map) return
    const add = () => {
      try {
        if (!map.getSource(source)) {
          map.addSource(source, {
            type: 'geojson',
            data: latest.current.data,
          } as MapSourceSpecification)
        }
        for (const layer of latest.current.layers(source)) {
          const id = `${PREFIX}${layer.id}`
          if (!map.getLayer(id)) map.addLayer({ ...layer, id } as MapLayerSpecification)
        }
      } catch {
        // Стиль ещё грузится — слои добавит `style.load`
      }
    }
    add()
    map.on('style.load', add)
    return () => {
      map.off('style.load', add)
      try {
        for (const layer of latest.current.layers(source)) {
          const id = `${PREFIX}${layer.id}`
          if (map.getLayer(id)) map.removeLayer(id)
        }
        if (map.getSource(source)) map.removeSource(source)
      } catch {
        // Карта уже удалена
      }
    }
  }, [map, source, look])

  useEffect(() => {
    if (!map) return
    const target = map.getSource(source) as unknown as GeoJsonSource | undefined
    target?.setData(data)
  }, [map, source, data])
}
