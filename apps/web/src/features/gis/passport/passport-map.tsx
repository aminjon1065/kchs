import {
  type Bbox,
  type FilterNode,
  type LayerRecord,
  LayerStyle,
  type Locale,
  type MapCamera,
} from '@kchs/contracts'
import { compileLayerStyle, type StyleField } from '@kchs/map-style'
import {
  MapCanvas,
  type MapClickEvent,
  type MapLayerSpecification,
  type MapSourceSpecification,
  useMapTheme,
} from '@kchs/ui'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { registerPmtilesProtocol, useBasemapStyle } from '../basemaps.js'
import type { GeoCollection } from '../choropleth/geojson.js'
import { type RenderEntry, useRenderedLayers } from '../layer-render.js'
import { layerQuery } from '../queries.js'
import { boundaryQuery, childShapesQuery } from './queries.js'

const DEFAULT_CAMERA: MapCamera = { center: [69, 38.6], zoom: 6, bearing: 0, pitch: 0 }
const BOUNDARY = 'passport-boundary'
const CHILDREN = 'passport-children'
const LABEL = 'label'

/** Слой объектов на карте паспорта: слой датасета и поле территории для отбора. */
export interface PassportLayer {
  layerId: string
  territoryField: string
}

const BOUNDARY_STYLE = LayerStyle.parse({
  version: 1,
  geometry: 'polygon',
  renderer: { kind: 'simple', color: 'accent' },
  polygon: { fillOpacity: 0.05, outline: { width: 2.5, color: 'accent' } },
})

const CHILDREN_STYLE = LayerStyle.parse({
  version: 1,
  geometry: 'polygon',
  renderer: { kind: 'simple', color: 'neutral' },
  // Заливка почти прозрачная: по ней выбирается дочерняя единица
  polygon: { fillOpacity: 0.01, outline: { width: 1, color: 'neutral' } },
  label: { field: LABEL, minZoom: 5, size: 11 },
})

const CHILD_FIELDS: StyleField[] = [{ key: LABEL, type: 'text' }]

/** Тепловая карта вместо стиля точечного слоя: плотность объектов в территории. */
function heatStyle(layer: LayerRecord): LayerStyle {
  return LayerStyle.parse({
    ...layer.style,
    renderer: { kind: 'heatmap', radius: 18, intensity: 1, palette: { name: 'orange' } },
    label: null,
  })
}

/** Название единицы на языке интерфейса — свойством для подписи. */
function withLabels(collection: GeoCollection, locale: Locale): GeoCollection {
  return {
    type: 'FeatureCollection',
    features: collection.features.map((feature) => {
      const props = feature.properties
      const name =
        (locale === 'en' ? props.name_en : locale === 'tg' ? props.name_tg : null) ?? props.name
      return { ...feature, properties: { ...props, [LABEL]: name } }
    }),
  }
}

/**
 * Карта паспорта (03-screens.md §11, ADR-0077): граница единицы, дочерние
 * единицы (щелчок — их паспорт), объекты слоёв внутри территории — тайлы с
 * условием `within` по полю территории (`f`), по желанию тепловой картой.
 */
export function PassportMap({
  territoryId,
  name,
  bbox,
  layers,
  heatmap,
  onChild,
  onLegends,
}: {
  territoryId: string
  name: string
  bbox: Bbox | null
  layers: readonly PassportLayer[]
  heatmap: boolean
  onChild: (id: string) => void
  /** Легенды слоёв объектов — для панели рядом с картой. */
  onLegends?: (legends: ReturnType<typeof useRenderedLayers>['legends']) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale) as Locale
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const theme = useMapTheme(root)
  const basemap = useBasemapStyle(null, 'muted')
  const [camera, setCamera] = useState<MapCamera>(DEFAULT_CAMERA)
  const [fit, setFit] = useState<{ bbox: Bbox; key: string } | null>(null)
  const boundary = useQuery(boundaryQuery(territoryId))
  const children = useQuery(childShapesQuery(territoryId))

  const box = bbox ?? boundary.data?.bbox ?? null
  const boxKey = box ? `${territoryId}:${box.join(',')}` : ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: охват — по значению рамки
  useEffect(() => {
    if (box) setFit({ bbox: box, key: boxKey })
  }, [boxKey])

  const records = useQueries({
    queries: layers.map((item) => ({ ...layerQuery(item.layerId), retry: false })),
  })
  const entries: RenderEntry[] = records.flatMap((query) => {
    const layer = query.data
    if (!layer) return []
    const point = layer.geometryType === 'point'
    return [
      {
        // Смена стиля на тепловой — новая «версия» слоя: стиль и тайлы перестраиваются
        layer:
          heatmap && point
            ? { ...layer, style: heatStyle(layer), version: layer.version + 1_000_000 }
            : layer,
        visible: true,
        opacity: 1,
      },
    ]
  })
  const filters = useMemo(() => {
    const out: Record<string, FilterNode> = {}
    for (const item of layers) {
      out[item.layerId] = { field: item.territoryField, op: 'within', value: territoryId }
    }
    return out
  }, [layers, territoryId])
  const rendered = useRenderedLayers(entries, theme, { filters })
  const legendsKey = [...rendered.legends.keys()].join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: легенды — по составу слоёв
  useEffect(() => onLegends?.(rendered.legends), [legendsKey, heatmap, theme])

  const labelled = useMemo(
    () => (children.data ? withLabels(children.data, locale) : null),
    [children.data, locale],
  )
  const own = useMemo(() => {
    if (!theme) return { sources: {}, below: [], above: [], clickable: [] as string[] }
    const sources: Record<string, MapSourceSpecification> = {}
    const below: MapLayerSpecification[] = []
    const above: MapLayerSpecification[] = []
    const clickable: string[] = []
    if (labelled && labelled.features.length > 0) {
      sources[CHILDREN] = { type: 'geojson', data: labelled as never, promoteId: 'id' }
      const compiled = compileLayerStyle(CHILDREN_STYLE, {
        id: CHILDREN,
        source: CHILDREN,
        sourceLayer: null,
        geometry: 'polygon',
        fields: CHILD_FIELDS,
        theme,
        locale,
      })
      for (const layer of compiled.layers) {
        below.push(layer)
        const role = (layer.metadata as Record<string, unknown> | undefined)?.['kchs:role']
        if (role === 'fill') clickable.push(layer.id)
      }
    }
    if (boundary.data) {
      sources[BOUNDARY] = { type: 'geojson', data: boundary.data as never }
      const compiled = compileLayerStyle(BOUNDARY_STYLE, {
        id: BOUNDARY,
        source: BOUNDARY,
        sourceLayer: null,
        geometry: 'polygon',
        fields: [],
        theme,
        locale,
      })
      above.push(...compiled.layers)
    }
    return { sources, below, above, clickable }
  }, [labelled, boundary.data, theme, locale])

  const onFeatureClick = (event: MapClickEvent) => {
    const hit = event.features.find((feature) => feature.source === CHILDREN)
    if (hit?.id !== null && hit?.id !== undefined) onChild(String(hit.id))
  }

  return (
    <div ref={setRoot} className="flex min-h-0 flex-1 flex-col">
      <MapCanvas
        className="min-h-[360px] flex-1"
        basemapStyle={basemap.style}
        prepare={registerPmtilesProtocol}
        sources={{ ...own.sources, ...rendered.sources }}
        layers={[...own.below, ...rendered.layers, ...own.above]}
        images={rendered.images}
        camera={camera}
        onCameraChange={setCamera}
        fitBounds={fit}
        interactiveLayerIds={own.clickable}
        onFeatureClick={onFeatureClick}
        aria-label={t('gis.passport.mapLabel', { name })}
      />
    </div>
  )
}
