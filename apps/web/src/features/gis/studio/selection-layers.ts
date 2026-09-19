import type { LayerRecord } from '@kchs/contracts'
import type { MapTheme } from '@kchs/map-style'
import type { MapLayerSpecification } from '@kchs/ui'

/**
 * Подсветка выделенных объектов (ADR-0073): поверх слоя — кольцо точки, полоса
 * линии, заливка и контур полигона цветом акцента. Видимость — `feature-state
 * selected`, которое ставит `MapCanvas` по выделению студии: смена выделения не
 * перестраивает стиль и не перезапрашивает тайлы. Скопления не подсвечиваются.
 */

/** Выражения стиля MapLibre — как JSON: типы спецификации проверяет сам MapLibre. */
type Expression = unknown[]

const SELECTED: Expression = ['boolean', ['feature-state', 'selected'], false]
const when = (on: number, off = 0): Expression => ['case', SELECTED, on, off]
const NOT_CLUSTER: Expression = ['!', ['>', ['coalesce', ['get', 'point_count'], 1], 1]]

const geometryIs = (type: 'Point' | 'LineString' | 'Polygon'): Expression => [
  'in',
  ['geometry-type'],
  ['literal', [type, `Multi${type}`]],
]

const asLayer = (spec: Record<string, unknown>) => spec as unknown as MapLayerSpecification

/** Наибольший размер точки стиля, px: кольцо охватывает и крупные значки. */
function pointSize(layer: LayerRecord): number {
  const { point, renderer } = layer.style
  return Math.max(
    point.size,
    point.sizeBy?.max ?? 0,
    renderer.kind === 'proportional' ? renderer.max : 0,
  )
}

export function selectionLayers(
  record: LayerRecord,
  source: string,
  theme: MapTheme,
): MapLayerSpecification[] {
  const accent = theme.tokens.accent
  const base = (role: string) => ({
    id: `${record.id}:selection-${role}`,
    source,
    'source-layer': 'layer',
    metadata: { 'kchs:layer': record.id, 'kchs:role': 'selection' },
    ...(record.style.minZoom > 0 ? { minzoom: record.style.minZoom } : {}),
    ...(record.style.maxZoom < 22 ? { maxzoom: record.style.maxZoom + 1 } : {}),
  })
  const kind = record.geometryType
  const out: MapLayerSpecification[] = []
  if (kind === 'polygon' || kind === 'mixed') {
    out.push(
      asLayer({
        ...base('fill'),
        type: 'fill',
        filter: geometryIs('Polygon'),
        paint: { 'fill-color': accent, 'fill-opacity': when(0.22) },
      }),
      asLayer({
        ...base('outline'),
        type: 'line',
        filter: geometryIs('Polygon'),
        layout: { 'line-join': 'round' },
        paint: { 'line-color': accent, 'line-width': when(2.5), 'line-opacity': when(1) },
      }),
    )
  }
  if (kind === 'line' || kind === 'mixed') {
    out.push(
      asLayer({
        ...base('line'),
        type: 'line',
        filter: geometryIs('LineString'),
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': accent,
          'line-width': when(record.style.line.width + 5),
          'line-opacity': when(0.55),
        },
      }),
    )
  }
  if (kind === 'point' || kind === 'mixed') {
    out.push(
      asLayer({
        ...base('point'),
        type: 'circle',
        filter: ['all', geometryIs('Point'), NOT_CLUSTER],
        paint: {
          'circle-radius': Math.round(pointSize(record) / 2) + 5,
          'circle-color': accent,
          'circle-opacity': when(0.18),
          'circle-stroke-color': accent,
          'circle-stroke-width': when(2.5),
          'circle-stroke-opacity': when(1),
          'circle-pitch-alignment': 'map',
        },
      }),
    )
  }
  return out
}
