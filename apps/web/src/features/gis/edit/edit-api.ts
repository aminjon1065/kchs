import type {
  DatasetRowConflict,
  FeatureEditInput,
  FeatureEditReview,
  FeatureEditStatus,
  FeatureGeometry,
  LayerRecord,
} from '@kchs/contracts'
import { type QueryClient, queryOptions } from '@tanstack/react-query'
import { dataKeys } from '~/features/data/index.js'
import { ApiError, http } from '~/shared/api/client.js'
import type { Position } from './geometry.js'

/** Ключи кэша правки объектов слоя (ADR-0076). */
export const editKeys = {
  access: (layerId: string) => ['layer', layerId, 'editing'] as const,
  edits: (layerId: string) => ['layer', layerId, 'edits'] as const,
  snap: (layerId: string, bbox: string, version: number) =>
    ['layer', layerId, 'snap', bbox, version] as const,
}

/** Как пользователь правит объекты слоя: напрямую, на проверку или никак. */
export const layerEditingQuery = (layerId: string) =>
  queryOptions({
    queryKey: editKeys.access(layerId),
    queryFn: () => http.get('/gis/layers/:id/editing', { params: { id: layerId } }),
    staleTime: 30_000,
  })

/** Правки модерируемого слоя: проверяющему — все, остальным — свои. */
export const featureEditsQuery = (
  layerId: string,
  scope: 'all' | 'mine',
  status?: FeatureEditStatus,
) =>
  queryOptions({
    queryKey: [...editKeys.edits(layerId), scope, status ?? 'any'] as const,
    queryFn: async () =>
      (
        await http.get('/gis/layers/:id/edits', {
          params: { id: layerId },
          query: { scope, ...(status ? { status } : {}) },
        })
      ).items,
  })

/** Объекты слоя в охвате — для привязки к вершинам и рёбрам (до 2000 на слой). */
export const snapFeaturesQuery = (layer: LayerRecord, bbox: string) =>
  queryOptions({
    queryKey: editKeys.snap(layer.id, bbox, layer.datasetVersion),
    queryFn: async () =>
      (
        await http.get('/gis/layers/:id/features', {
          params: { id: layer.id },
          query: { bbox, limit: 2000 },
        })
      ).features,
    staleTime: 60_000,
  })

/**
 * Территория по точке объекта (ADR-0067): цепочка единиц с границей, покрывающих
 * точку, — для авто-территории формы; точка округлена до ~10 м.
 */
export const reverseGeocodeQuery = (point: Position | null) =>
  queryOptions({
    queryKey: [
      'geocode',
      'reverse',
      point ? point.map((n) => n.toFixed(4)).join(',') : '',
    ] as const,
    queryFn: () =>
      http.get('/gis/geocode/reverse', { query: { lon: point?.[0] ?? 0, lat: point?.[1] ?? 0 } }),
    enabled: point !== null,
    staleTime: 10 * 60_000,
  })

export const editApi = {
  create: (layerId: string, values: Record<string, unknown>, geometry: FeatureGeometry) =>
    http.post('/gis/layers/:id/features', { params: { id: layerId }, body: { values, geometry } }),
  update: (
    layerId: string,
    rowId: string,
    patch: { values: Record<string, unknown>; geometry?: FeatureGeometry; ver: number },
  ) =>
    http.patch('/gis/layers/:id/features/:rowId', { params: { id: layerId, rowId }, body: patch }),
  remove: (layerId: string, rowId: string, ver: number) =>
    http.delete('/gis/layers/:id/features/:rowId', {
      params: { id: layerId, rowId },
      query: { ver },
    }),
  submit: (layerId: string, input: FeatureEditInput) =>
    http.post('/gis/layers/:id/edits', { params: { id: layerId }, body: input }),
  review: (layerId: string, editId: string, input: FeatureEditReview) =>
    http.post('/gis/layers/:id/edits/:editId/review', {
      params: { id: layerId, editId },
      body: input,
    }),
  feature: (layerId: string, rowId: string) =>
    http.get('/gis/layers/:id/features/:rowId', { params: { id: layerId, rowId } }),
}

/** 409 правки строки: текущее состояние и поля, изменённые с тех пор. */
export function conflictOf(error: unknown): DatasetRowConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  const data = (error.problem as { data?: Partial<DatasetRowConflict> }).data
  return data?.current ? { current: data.current, changedFields: data.changedFields ?? [] } : null
}

/**
 * После записи: слой перечитывается — новая версия данных в адресе тайлов
 * (ADR-0064), датасет, его строки и история, правки и счётчик проверки.
 */
export function refreshAfterWrite(client: QueryClient, layer: LayerRecord): void {
  // Все слои карты: у других слоёв того же датасета тоже новая версия данных
  void client.invalidateQueries({ queryKey: ['layer'] })
  void client.invalidateQueries({ queryKey: dataKeys.dataset(layer.datasetId) })
}
