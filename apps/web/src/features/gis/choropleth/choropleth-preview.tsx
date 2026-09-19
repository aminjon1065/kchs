import {
  CHOROPLETH_FIELDS,
  ChoroplethParams,
  type ChoroplethParamsInput,
  choroplethLayerStyle,
  choroplethValueField,
  type QueryResult,
} from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import { Callout, Skeleton, useDebouncedValue } from '@kchs/ui'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { ChoroplethMap } from './choropleth-map.js'
import { numericValues, resultFeatures, resultStyleFields } from './geojson.js'

/**
 * Предпросмотр хороплета (07-gis-engine.md §10): запрос мастера на сервере с
 * правами смотрящего без сохранения — карта с классами и легендой, число
 * территорий и диапазон значений.
 */
export function ChoroplethPreview({ params }: { params: ChoroplethParamsInput }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  // Классы и палитра меняют только стиль: запрос — без них, чтобы не спрашивать сервер заново
  const request = useDebouncedValue(JSON.stringify({ ...params, style: undefined }), 300)
  const preview = useQuery({
    queryKey: ['choropleth', 'preview', request],
    queryFn: () =>
      http.post<QueryResult>('/analyses/preview', {
        choropleth: { ...JSON.parse(request), style: params.style },
      }),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 60_000,
  })
  const parsed = useMemo(() => ChoroplethParams.parse(params), [params])
  const style = useMemo(() => choroplethLayerStyle(parsed), [parsed])
  const features = useMemo(
    () =>
      preview.data
        ? resultFeatures(preview.data, CHOROPLETH_FIELDS.geometry)
        : { type: 'FeatureCollection' as const, features: [] },
    [preview.data],
  )
  const fields = useMemo(
    () => (preview.data ? resultStyleFields(preview.data) : []),
    [preview.data],
  )

  if (preview.isLoading) return <Skeleton className="h-72 w-full" />
  if (preview.error) {
    return (
      <Callout tone="warning">
        {t('gis.choropleth.previewFailed', {
          reason: preview.error instanceof ApiError ? preview.error.message : t('errors.unknown'),
        })}
      </Callout>
    )
  }
  if (features.features.length === 0) {
    return <Callout tone="info">{t('gis.choropleth.previewEmpty')}</Callout>
  }
  const values = numericValues(features, choroplethValueField(parsed))
  const format = fields.find((field) => field.key === choroplethValueField(parsed))?.format ?? {}
  const show = (value: number) => formatNumber(value, format ?? {}, { locale })

  return (
    <div className="flex flex-col gap-2">
      <ChoroplethMap
        className="h-72 overflow-hidden rounded-md border border-line"
        features={features}
        style={style}
        fields={fields}
        aria-label={t('gis.choropleth.previewLabel')}
      />
      <p className="text-xs text-fg-muted">
        {values.length > 0
          ? t('gis.choropleth.previewSummary', {
              count: features.features.length,
              min: show(Math.min(...values)),
              max: show(Math.max(...values)),
            })
          : t('gis.choropleth.previewNoValues', { count: features.features.length })}
      </p>
    </div>
  )
}
