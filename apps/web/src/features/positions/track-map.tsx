import type { MapCamera, PositionFix } from '@kchs/contracts'
import {
  MapCanvas,
  type MapLayerSpecification,
  type MapSourceSpecification,
  useMapTheme,
} from '@kchs/ui'
import { useMemo, useState } from 'react'
import { registerPmtilesProtocol, useBasemapStyle } from '~/features/gis/index.js'
import { useT } from '~/shared/i18n.js'
import { trackBounds } from './track-bounds.js'

const SOURCE = 'device-track'
/**
 * Трек устройства на карте (ADR-0203): линия по времени, точки и последняя точка
 * крупнее. Точки — по возрастанию времени; карта показывает их охват при открытии и
 * смене периода (`fitKey`), а новая точка по realtime вид не сбивает.
 */
export function TrackMap({ points, fitKey }: { points: readonly PositionFix[]; fitKey: string }) {
  const t = useT()
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const theme = useMapTheme(root)
  const basemap = useBasemapStyle(null, 'muted', { mode: theme?.mode })
  const last = points.at(-1)
  const [camera, setCamera] = useState<MapCamera>(() => ({
    center: last ? [last.lon, last.lat] : [71, 38.7],
    zoom: 11,
    bearing: 0,
    pitch: 0,
  }))
  const hasPoints = points.length > 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: охват — по ключу периода, новые точки рамку не двигают
  const bbox = useMemo(() => trackBounds(points), [fitKey, hasPoints])

  const sources = useMemo<Record<string, MapSourceSpecification>>(
    () => ({
      [SOURCE]: {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [
            ...(points.length > 1
              ? [
                  {
                    type: 'Feature' as const,
                    geometry: {
                      type: 'LineString' as const,
                      coordinates: points.map((point) => [point.lon, point.lat]),
                    },
                    properties: { kind: 'line' },
                  },
                ]
              : []),
            ...points.map((point, index) => ({
              type: 'Feature' as const,
              geometry: { type: 'Point' as const, coordinates: [point.lon, point.lat] },
              properties: { kind: index === points.length - 1 ? 'last' : 'fix' },
            })),
          ],
        },
      },
    }),
    [points],
  )
  const layers = useMemo<MapLayerSpecification[]>(
    () =>
      theme
        ? [
            {
              id: `${SOURCE}-line`,
              type: 'line',
              source: SOURCE,
              filter: ['==', ['get', 'kind'], 'line'],
              layout: { 'line-join': 'round', 'line-cap': 'round' },
              paint: { 'line-color': theme.tokens.accent, 'line-width': 3, 'line-opacity': 0.8 },
            },
            {
              id: `${SOURCE}-fixes`,
              type: 'circle',
              source: SOURCE,
              filter: ['==', ['get', 'kind'], 'fix'],
              paint: {
                'circle-radius': 3,
                'circle-color': theme.tokens.accent,
                'circle-stroke-color': theme.surface,
                'circle-stroke-width': 1,
              },
            },
            {
              id: `${SOURCE}-last`,
              type: 'circle',
              source: SOURCE,
              filter: ['==', ['get', 'kind'], 'last'],
              paint: {
                'circle-radius': 7,
                'circle-color': theme.tokens.accent,
                'circle-stroke-color': theme.surface,
                'circle-stroke-width': 2,
              },
            },
          ]
        : [],
    [theme],
  )

  return (
    <div ref={setRoot} className="h-72 min-h-0">
      <MapCanvas
        className="h-full rounded-md"
        basemapStyle={basemap.style}
        prepare={registerPmtilesProtocol}
        sources={sources}
        layers={layers}
        camera={camera}
        onCameraChange={setCamera}
        fitBounds={bbox ? { bbox, key: fitKey } : null}
        aria-label={t('positions.track.map')}
      />
    </div>
  )
}
