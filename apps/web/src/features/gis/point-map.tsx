import type { MapCamera } from '@kchs/contracts'
import {
  cn,
  MapCanvas,
  type MapLayerSpecification,
  type MapSourceSpecification,
  Skeleton,
  useMapTheme,
} from '@kchs/ui'
import { useMemo, useState } from 'react'
import { useT } from '~/shared/i18n.js'
import { registerPmtilesProtocol, useBasemapStyle } from './basemaps.js'

const SOURCE = 'point'
/** Зум превью места: район и ближайшие населённые пункты. */
const DEFAULT_ZOOM = 10

/**
 * Превью места (ADR-0230): точка по координатам на подложке в теме интерфейса — для
 * карточек других фич (документ, донесение). Только карта и маркер: без перетаскивания,
 * масштаба и выбора; подробности — на карте модуля.
 */
export function PointMap({
  point,
  height = 160,
  zoom = DEFAULT_ZOOM,
  label,
  className,
}: {
  /** Долгота, широта — порядок GeoJSON. */
  point: readonly [number, number]
  /** Высота превью, px. */
  height?: number
  zoom?: number
  /** Подпись для программы чтения с экрана; по умолчанию — «Место на карте». */
  label?: string
  className?: string
}) {
  const t = useT()
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const theme = useMapTheme(root)
  // Схема по теме интерфейса — как у карты областей предупреждения
  const basemap = useBasemapStyle(null, theme?.mode === 'dark' ? 'dark' : 'light')
  const [lon, lat] = point
  const camera = useMemo<MapCamera>(
    () => ({ center: [lon, lat], zoom, bearing: 0, pitch: 0 }),
    [lon, lat, zoom],
  )

  const sources = useMemo<Record<string, MapSourceSpecification>>(
    () => ({
      [SOURCE]: {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [lon, lat] },
        },
      },
    }),
    [lon, lat],
  )
  const accent = theme?.tokens.accent
  const surface = theme?.surface
  const layers = useMemo<MapLayerSpecification[]>(
    () =>
      accent && surface
        ? [
            {
              id: 'point-halo',
              type: 'circle',
              source: SOURCE,
              paint: { 'circle-radius': 14, 'circle-color': accent, 'circle-opacity': 0.22 },
            },
            {
              id: 'point-mark',
              type: 'circle',
              source: SOURCE,
              paint: {
                'circle-radius': 6,
                'circle-color': accent,
                'circle-stroke-color': surface,
                'circle-stroke-width': 2,
              },
            },
          ]
        : [],
    [accent, surface],
  )

  return (
    <div
      ref={setRoot}
      className={cn('overflow-hidden rounded-md border border-line', className)}
      style={{ height }}
    >
      {basemap.style ? (
        <MapCanvas
          className="h-full w-full"
          basemapStyle={basemap.style}
          prepare={registerPmtilesProtocol}
          sources={sources}
          layers={layers}
          camera={camera}
          staticView
          aria-label={label ?? t('gis.map.pointPreview')}
        />
      ) : (
        <Skeleton className="h-full w-full" />
      )}
    </div>
  )
}
