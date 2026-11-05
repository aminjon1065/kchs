import {
  type Bbox,
  type FilterNode,
  LayerStyle,
  type Locale,
  type MapCamera,
  type QueryResult,
  type QuerySpec,
} from '@kchs/contracts'
import { compileLayerStyle } from '@kchs/map-style'
import {
  Callout,
  MapCanvas,
  type MapClickEvent,
  type MapLayerSpecification,
  type MapSourceSpecification,
  Skeleton,
  useDebouncedValue,
  useMapTheme,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useLinkedDataset, useLinkSource, useViewContext } from '~/shared/workspace/view-context.js'
import { BasemapSwitcher } from './basemap-switcher.js'
import { registerPmtilesProtocol, useBasemapStyle } from './basemaps.js'
import { featuresBbox } from './choropleth/geojson.js'
import { apiFailureMessage, explorePointsQuery } from './queries.js'

/** Точек на карте не больше: дальше — уточнить фильтр таблицы. */
const LIMIT = 5000
const SOURCE = 'linked-points'
const NO_IDS: readonly string[] = []
const DEFAULT_CAMERA: MapCamera = { center: [69, 38.6], zoom: 5.5, bearing: 0, pitch: 0 }

/** Точки — простым стилем без скоплений: каждую можно выбрать и подсветить. */
const POINTS_STYLE = LayerStyle.parse({
  version: 1,
  geometry: 'point',
  renderer: { kind: 'simple', color: 'accent' },
  point: { size: 6 },
})

/** Выражения стиля MapLibre — как JSON: типы спецификации проверяет сам MapLibre. */
const SELECTED = ['boolean', ['feature-state', 'selected'], false]

/** Запрос точек: фильтр таблицы, строки с местом, идентификатор строки и место. */
export function linkedPointsSpec(
  datasetId: string,
  field: string,
  where: FilterNode | null,
): QuerySpec {
  return {
    version: 1,
    source: { kind: 'dataset', id: datasetId },
    steps: [
      ...(where ? [{ type: 'filter' as const, where }] : []),
      { type: 'filter', where: { field, op: 'not_empty' } },
      { type: 'select', fields: ['_id', field] },
      { type: 'limit', limit: LIMIT, offset: 0 },
    ],
    params: {},
    options: { cache: true, approxCount: true },
  }
}

interface PointFeature {
  type: 'Feature'
  geometry: Record<string, unknown>
  properties: { _id: string }
}

/** Строки результата → точки с идентификатором строки (`_id` строкой, как в таблице). */
export function linkedFeatures(result: QueryResult | undefined, field: string) {
  const features: PointFeature[] = []
  if (result) {
    const idAt = result.fields.findIndex((item) => item.name === '_id')
    const geometryAt = result.fields.findIndex((item) => item.name === field)
    for (const row of result.rows) {
      const geometry = row[geometryAt]
      if (!geometry || typeof geometry !== 'object') continue
      features.push({
        type: 'Feature',
        geometry: geometry as Record<string, unknown>,
        properties: { _id: String(row[idAt]) },
      })
    }
  }
  return { type: 'FeatureCollection' as const, features }
}

/**
 * Карта рядом с таблицей датасета (ADR-0230, связанные представления ADR-0073): точки
 * строк под фильтром таблицы; выделение строк в таблице подсвечивает точки кольцом,
 * щелчок по точке выделяет её строку — через связь группы, в которой таблица.
 */
export function LinkedPointsMap({
  datasetId,
  field,
  where,
  group,
  label,
}: {
  datasetId: string
  /** Поле геометрии датасета. */
  field: string
  /** Фильтр таблицы (свой и пришедший из связи) — точки под тем же условием. */
  where: FilterNode | null
  /** Группа связи таблицы: панели или своя группа экрана датасета. */
  group: string
  /** Подпись точек в легенде — название датасета. */
  label: string
}) {
  const t = useT()
  const locale = useLocale() as Locale
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const theme = useMapTheme(root)
  const basemap = useBasemapStyle(null, theme?.mode === 'dark' ? 'dark' : 'light')
  const [camera, setCamera] = useState<MapCamera>(DEFAULT_CAMERA)
  const [fit, setFit] = useState<{ bbox: Bbox; key: string } | null>(null)
  const source = useLinkSource(group)
  const linked = useLinkedDataset(group, datasetId)

  const request = useDebouncedValue(JSON.stringify(linkedPointsSpec(datasetId, field, where)), 300)
  const points = useQuery(explorePointsQuery(request))
  const features = useMemo(() => linkedFeatures(points.data, field), [points.data, field])

  // Охват — по точкам под фильтром: новый фильтр показывает свои точки целиком
  const bbox = featuresBbox(features)
  const bboxKey = bbox ? bbox.join(',') : ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: охват — по значению рамки
  useEffect(() => {
    if (bbox) setFit({ bbox, key: bboxKey })
  }, [bboxKey])

  const compiled = useMemo(
    () =>
      theme
        ? compileLayerStyle(POINTS_STYLE, {
            id: SOURCE,
            source: SOURCE,
            sourceLayer: null,
            geometry: 'point',
            fields: [],
            theme,
            locale,
          })
        : null,
    [theme, locale],
  )
  const pointLayers = useMemo(() => compiled?.layers ?? [], [compiled])
  // Кольцо выделенной строки — поверх точек; видимость — feature-state `selected`
  const layers = useMemo<MapLayerSpecification[]>(() => {
    if (!theme) return pointLayers
    const accent = theme.tokens.accent
    const ring = {
      id: `${SOURCE}:selection`,
      type: 'circle',
      source: SOURCE,
      paint: {
        'circle-radius': 9,
        'circle-color': accent,
        'circle-opacity': ['case', SELECTED, 0.18, 0],
        'circle-stroke-color': accent,
        'circle-stroke-width': ['case', SELECTED, 2, 0],
      },
    } as unknown as MapLayerSpecification
    return [...pointLayers, ring]
  }, [pointLayers, theme])
  const sources = useMemo<Record<string, MapSourceSpecification>>(
    () => ({ [SOURCE]: { type: 'geojson', data: features as never, promoteId: '_id' } }),
    [features],
  )

  // Выделение пришло из таблицы (другой источник группы) — подсвечиваем эти строки
  const selectedIds = linked.selection?.ids ?? NO_IDS
  const selection = useMemo(() => selectedIds.map((id) => ({ source: SOURCE, id })), [selectedIds])

  const onFeatureClick = (event: MapClickEvent) => {
    const hit = event.features.find((feature) => feature.source === SOURCE)
    const id = hit ? String(hit.properties._id ?? '') : ''
    useViewContext.getState().select(group, datasetId, id ? [id] : [], source)
  }

  if (points.isLoading) return <Skeleton className="h-full w-full" />
  if (points.error) {
    return (
      <Callout tone="warning" className="m-3">
        {t('gis.points.failed', {
          reason: apiFailureMessage(points.error) ?? t('errors.unknown'),
        })}
      </Callout>
    )
  }

  const count = features.features.length
  return (
    <div ref={setRoot} className="relative h-full min-h-0">
      <MapCanvas
        className="h-full"
        basemapStyle={basemap.style}
        prepare={registerPmtilesProtocol}
        controls={<BasemapSwitcher auto={basemap.auto} current={basemap.basemap} />}
        sources={sources}
        layers={layers}
        images={compiled?.images ?? []}
        camera={camera}
        onCameraChange={setCamera}
        fitBounds={fit}
        interactiveLayerIds={pointLayers.map((layer) => layer.id)}
        onFeatureClick={onFeatureClick}
        selection={selection}
        aria-label={t('gis.linkedPoints.label', { name: label })}
      >
        <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1.5 rounded-md border border-line bg-surface/95 px-3 py-2 text-xs text-fg shadow-md">
          <span className="flex items-center gap-2">
            <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-accent" />
            <span className="tabular">
              {count >= LIMIT
                ? t('gis.linkedPoints.truncated', { name: label, count: LIMIT })
                : t('gis.linkedPoints.points', { name: label, count })}
            </span>
          </span>
          {selectedIds.length > 0 ? (
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className="size-3 shrink-0 rounded-full border-2 border-accent bg-accent-subtle"
              />
              <span className="tabular">
                {t('gis.linkedPoints.selected', { count: selectedIds.length })}
              </span>
            </span>
          ) : count === 0 ? (
            <span className="text-fg-muted">{t('gis.points.empty')}</span>
          ) : null}
        </div>
      </MapCanvas>
    </div>
  )
}
