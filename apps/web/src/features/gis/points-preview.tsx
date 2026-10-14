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
  type MapSourceSpecification,
  Skeleton,
  useDebouncedValue,
  useMapTheme,
} from '@kchs/ui'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { ApiError, http } from '~/shared/api/client.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { BasemapSwitcher } from './basemap-switcher.js'
import { registerPmtilesProtocol, useBasemapStyle } from './basemaps.js'
import { featuresBbox, resultFeatures } from './choropleth/geojson.js'

/** Точек на карте не больше: дальше — уточнить фильтр. */
const POINTS_LIMIT = 5000
const SOURCE = 'explore-points'
const DEFAULT_CAMERA: MapCamera = { center: [69, 38.6], zoom: 5.5, bearing: 0, pitch: 0 }

/** Точки — простым стилем; близкие собирает в кластеры MapLibre (`point_count`, как у тайлов). */
const POINTS_STYLE = LayerStyle.parse({
  version: 1,
  geometry: 'point',
  renderer: { kind: 'simple', color: 'accent' },
  point: { size: 7 },
  cluster: { enabled: true },
})

/** Запрос точек: фильтр плана, только строки с точкой, только поле точки. */
export function pointsSpec(datasetId: string, field: string, filter: FilterNode | null): QuerySpec {
  return {
    version: 1,
    source: { kind: 'dataset', id: datasetId },
    steps: [
      ...(filter ? [{ type: 'filter' as const, where: filter }] : []),
      { type: 'filter', where: { field, op: 'not_empty' } },
      { type: 'select', fields: [field] },
      { type: 'limit', limit: POINTS_LIMIT, offset: 0 },
    ],
    params: {},
    options: { cache: true, approxCount: true },
  }
}

/**
 * Точки датасета на карте с кластеризацией (ADR-0217, «Дополнено»): вид «Карта»
 * «Исследования» для поля-точки. Строки — запросом с фильтром плана под правами
 * смотрящего, не больше POINTS_LIMIT; кластеры собираются в браузере.
 */
export function PointsPreview({
  datasetId,
  field,
  filter,
}: {
  datasetId: string
  field: string
  filter: FilterNode | null
}) {
  const t = useT()
  const locale = useLocale() as Locale
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const theme = useMapTheme(root)
  const basemap = useBasemapStyle(null, 'muted', { mode: theme?.mode })
  const [camera, setCamera] = useState<MapCamera>(DEFAULT_CAMERA)
  const [fit, setFit] = useState<{ bbox: Bbox; key: string } | null>(null)
  const request = useDebouncedValue(JSON.stringify(pointsSpec(datasetId, field, filter)), 300)
  const points = useQuery({
    queryKey: ['explore', 'points', request],
    queryFn: (): Promise<QueryResult> =>
      http.post('/queries/run', { body: { spec: JSON.parse(request) as QuerySpec } }),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 60_000,
  })
  const features = useMemo(
    () =>
      points.data
        ? resultFeatures(points.data, field)
        : { type: 'FeatureCollection' as const, features: [] },
    [points.data, field],
  )
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
  const sources = useMemo<Record<string, MapSourceSpecification>>(
    () => ({
      [SOURCE]: {
        type: 'geojson',
        data: features as never,
        cluster: true,
        clusterRadius: POINTS_STYLE.cluster?.radius ?? 40,
        clusterMaxZoom: POINTS_STYLE.cluster?.maxZoom ?? 11,
      },
    }),
    [features],
  )

  if (points.isLoading) return <Skeleton className="h-96 w-full" />
  if (points.error) {
    return (
      <Callout tone="warning">
        {t('gis.points.failed', {
          reason: points.error instanceof ApiError ? points.error.message : t('errors.unknown'),
        })}
      </Callout>
    )
  }
  if (features.features.length === 0) {
    return <Callout tone="info">{t('gis.points.empty')}</Callout>
  }
  const count = features.features.length
  return (
    <div ref={setRoot} className="flex flex-col gap-2">
      <MapCanvas
        className="h-96 overflow-hidden rounded-md border border-line"
        basemapStyle={basemap.style}
        prepare={registerPmtilesProtocol}
        controls={<BasemapSwitcher auto={basemap.auto} current={basemap.basemap} />}
        sources={sources}
        layers={compiled?.layers ?? []}
        images={compiled?.images ?? []}
        camera={camera}
        onCameraChange={setCamera}
        fitBounds={fit}
        aria-label={t('gis.points.label')}
      />
      <p className="text-xs text-fg-muted">
        {count >= POINTS_LIMIT
          ? t('gis.points.truncated', { count: POINTS_LIMIT })
          : t('gis.points.summary', { count })}
      </p>
    </div>
  )
}
