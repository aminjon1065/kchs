import type { Bbox, LayerStyle, Locale, MapCamera } from '@kchs/contracts'
import { classify, compileLayerStyle, type StyleField } from '@kchs/map-style'
import {
  cn,
  MapCanvas,
  type MapClickEvent,
  MapLegend,
  type MapSourceSpecification,
  useMapTheme,
} from '@kchs/ui'
import { useEffect, useMemo, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { registerPmtilesProtocol, useBasemapStyle } from '../basemaps.js'
import { featuresBbox, type GeoCollection, numericValues } from './geojson.js'

/** Вид до охвата данных — Таджикистан. */
const DEFAULT_CAMERA: MapCamera = { center: [69, 38.6], zoom: 5.5, bearing: 0, pitch: 0 }
const SOURCE = 'choropleth'
/** Слои, объекты которых выбираются щелчком. */
const CLICKABLE = new Set(['fill'])

/**
 * Хороплет без слоя-объекта (предпросмотр мастера, дочерние единицы паспорта):
 * объекты GeoJSON в браузере, градуированный стиль компилирует `@kchs/map-style`
 * с классами по значениям объектов и темой дизайн-системы, легенда — поверх.
 */
export function ChoroplethMap({
  features,
  style,
  fields,
  idProperty,
  onSelect,
  className,
  'aria-label': label,
}: {
  features: GeoCollection
  style: LayerStyle
  fields: readonly StyleField[]
  /** Свойство — идентификатор объекта для щелчка (`promoteId`). */
  idProperty?: string
  onSelect?: (id: string) => void
  className?: string
  'aria-label': string
}) {
  const locale = useAppearance((s) => s.locale) as Locale
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const theme = useMapTheme(root)
  const basemap = useBasemapStyle(null, 'muted')
  const [camera, setCamera] = useState<MapCamera>(DEFAULT_CAMERA)
  const [fit, setFit] = useState<{ bbox: Bbox; key: string } | null>(null)

  const bbox = featuresBbox(features)
  const bboxKey = bbox ? bbox.join(',') : ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: охват — по значению рамки
  useEffect(() => {
    if (bbox) setFit({ bbox, key: bboxKey })
  }, [bboxKey])

  const compiled = useMemo(() => {
    if (!theme) return null
    const renderer = style.renderer
    // Сбой классов или стиля не должен ронять экран: карта остаётся без слоя данных
    try {
      const breaks =
        renderer.kind === 'graduated' && renderer.method !== 'manual'
          ? classify(numericValues(features, renderer.field), renderer.method, renderer.classes)
          : null
      return compileLayerStyle(style, {
        id: SOURCE,
        source: SOURCE,
        sourceLayer: null,
        geometry: 'polygon',
        fields,
        theme,
        locale,
        breaks,
      })
    } catch {
      return null
    }
  }, [features, style, fields, theme, locale])

  const sources = useMemo<Record<string, MapSourceSpecification>>(
    () => ({
      [SOURCE]: {
        type: 'geojson',
        data: features as never,
        ...(idProperty ? { promoteId: idProperty } : {}),
      },
    }),
    [features, idProperty],
  )
  const interactive = (compiled?.layers ?? [])
    .filter((layer) => {
      const role = (layer.metadata as Record<string, unknown> | undefined)?.['kchs:role']
      return typeof role === 'string' && CLICKABLE.has(role)
    })
    .map((layer) => layer.id)

  const onFeatureClick = (event: MapClickEvent) => {
    const hit = event.features[0]
    if (hit?.id !== null && hit?.id !== undefined) onSelect?.(String(hit.id))
  }

  return (
    <div ref={setRoot} className={cn('relative flex min-h-0 flex-col', className)}>
      <MapCanvas
        className="min-h-[240px] flex-1"
        basemapStyle={basemap.style}
        prepare={registerPmtilesProtocol}
        sources={sources}
        layers={compiled?.layers ?? []}
        camera={camera}
        onCameraChange={setCamera}
        fitBounds={fit}
        interactiveLayerIds={onSelect ? interactive : []}
        onFeatureClick={onSelect ? onFeatureClick : undefined}
        staticView
        aria-label={label}
      >
        {compiled?.legend.show && features.features.length > 0 ? (
          <div className="pointer-events-auto absolute bottom-2 left-2 z-10 max-w-[240px] rounded-md border border-line bg-surface p-2 shadow-sm">
            <MapLegend legend={compiled.legend} />
          </div>
        ) : null}
      </MapCanvas>
    </div>
  )
}
