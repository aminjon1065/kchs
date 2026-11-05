import type { Bbox, MapCamera } from '@kchs/contracts'
import {
  type HazardLevel,
  MapCanvas,
  type MapLayerSpecification,
  type MapSourceSpecification,
  Skeleton,
  useMapTheme,
} from '@kchs/ui'
import { useQueries } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { registerPmtilesProtocol, useBasemapStyle } from './basemaps.js'
import { territoryGeometryQuery } from './queries.js'

const SOURCE = 'areas'
const DEFAULT_CAMERA: MapCamera = { center: [69, 38.6], zoom: 5.5, bearing: 0, pitch: 0 }
/** Зум упрощения границ: области смотрятся целиком, подробности района не нужны. */
const GEOMETRY_ZOOM = 8

export interface MapArea {
  territoryId: string | null
  /** Кольцо полигона в порядке GeoJSON: долгота, широта. */
  polygon: ReadonlyArray<readonly [number, number]> | null
}

type Feature = {
  type: 'Feature'
  properties: Record<string, never>
  geometry: { type: string; coordinates: unknown }
}

/** Рамка точек кольца — для охвата карты по полигонам без территории. */
function ringBbox(ring: ReadonlyArray<readonly [number, number]>): Bbox {
  const lons = ring.map((point) => point[0])
  const lats = ring.map((point) => point[1])
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
}

function unionBbox(boxes: readonly Bbox[]): Bbox | null {
  if (boxes.length === 0) return null
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ]
}

/**
 * Области на карте (ADR-0230): границы территорий справочника и полигоны своими
 * точками, полупрозрачной заливкой цвета уровня шкалы обстановки. Охват — по всем
 * областям. Подпись уровня и состав областей показывает вызывающий рядом — цвет
 * без римской цифры здесь только дублирует их.
 */
export function AreasMap({
  areas,
  level,
  label,
  className,
}: {
  areas: readonly MapArea[]
  level: HazardLevel
  label: string
  className?: string
}) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const theme = useMapTheme(root)
  // Схема по теме интерфейса, а не серая под хороплеты: та светлая и в тёмной теме
  const basemap = useBasemapStyle(null, theme?.mode === 'dark' ? 'dark' : 'light')
  const [camera, setCamera] = useState<MapCamera>(DEFAULT_CAMERA)
  const [fit, setFit] = useState<{ bbox: Bbox; key: string } | null>(null)

  const territoryIds = [
    ...new Set(areas.flatMap((area) => (area.territoryId ? [area.territoryId] : []))),
  ]
  const geometries = useQueries({
    queries: territoryIds.map((id) => territoryGeometryQuery(id, GEOMETRY_ZOOM)),
  })
  const loading = geometries.some((query) => query.isLoading)
  const loadedKey = geometries.map((query) => (query.data ? query.data.id : '')).join(',')

  // biome-ignore lint/correctness/useExhaustiveDependencies: пересчёт — по загруженным границам и составу областей
  const { collection, bbox } = useMemo(() => {
    const features: Feature[] = []
    const boxes: Bbox[] = []
    for (const query of geometries) {
      if (!query.data) continue
      features.push({ type: 'Feature', properties: {}, geometry: query.data.geometry as never })
      boxes.push(query.data.bbox as Bbox)
    }
    for (const area of areas) {
      if (!area.polygon || area.polygon.length < 3) continue
      const ring = [...area.polygon, area.polygon[0]]
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [ring] },
      })
      boxes.push(ringBbox(area.polygon))
    }
    return { collection: { type: 'FeatureCollection', features }, bbox: unionBbox(boxes) }
  }, [loadedKey, areas])

  const bboxKey = bbox ? bbox.join(',') : ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: охват — по значению рамки
  useEffect(() => {
    if (bbox) setFit({ bbox, key: bboxKey })
  }, [bboxKey])

  const sources = useMemo<Record<string, MapSourceSpecification>>(
    () => ({ [SOURCE]: { type: 'geojson', data: collection as never } }),
    [collection],
  )
  const color = theme?.hazard[level]
  const layers = useMemo<MapLayerSpecification[]>(
    () =>
      color
        ? [
            {
              id: 'areas-fill',
              type: 'fill',
              source: SOURCE,
              paint: { 'fill-color': color, 'fill-opacity': 0.28 },
            },
            {
              id: 'areas-outline',
              type: 'line',
              source: SOURCE,
              layout: { 'line-join': 'round' },
              paint: { 'line-color': color, 'line-width': 1.5 },
            },
          ]
        : [],
    [color],
  )

  return (
    <div ref={setRoot} className={className}>
      {loading ? (
        <Skeleton className="h-full w-full" />
      ) : (
        <MapCanvas
          className="h-full w-full"
          basemapStyle={basemap.style}
          prepare={registerPmtilesProtocol}
          sources={sources}
          layers={layers}
          camera={camera}
          onCameraChange={setCamera}
          fitBounds={fit}
          aria-label={label}
        />
      )}
    </div>
  )
}
