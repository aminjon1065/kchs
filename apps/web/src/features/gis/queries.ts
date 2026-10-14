import type { QueryResult, QuerySpec } from '@kchs/contracts'
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import { ApiError } from '~/shared/api/errors.js'
import type { ApiBody, ApiQuery } from '~/shared/api/route-types.js'

/** Ключи кэша слоёв и карт. */
export const gisKeys = {
  layer: (id: string) => ['layer', id] as const,
  datasetLayers: (datasetId: string) => ['layers', 'dataset', datasetId] as const,
  map: (id: string) => ['map', id] as const,
  feature: (layerId: string, rowId: string) => ['layer', layerId, 'feature', rowId] as const,
  renderSettings: ['gis', 'render-settings'] as const,
}

/** Порог deck.gl в карте-студии (ADR-0110): настройка установки, меняется редко. */
export const gisRenderSettingsQuery = () =>
  queryOptions({
    queryKey: gisKeys.renderSettings,
    queryFn: () => http.get('/gis/render-settings'),
    staleTime: 5 * 60_000,
  })

/** Слой: стиль, поля тайла, экстент и версия данных (ADR-0064). */
export const layerQuery = (id: string) =>
  queryOptions({
    queryKey: gisKeys.layer(id),
    queryFn: () => http.get('/gis/layers/:id', { params: { id } }),
  })

/** Слои датасета, видимые пользователю, — «Показать на карте». */
export const datasetLayersQuery = (datasetId: string) =>
  queryOptions({
    queryKey: gisKeys.datasetLayers(datasetId),
    queryFn: async () => (await http.get('/gis/layers', { query: { datasetId } })).items,
  })

export const mapQuery = (id: string) =>
  queryOptions({
    queryKey: gisKeys.map(id),
    queryFn: () => http.get('/gis/maps/:id', { params: { id } }),
  })

/** Карточка объекта слоя по щелчку: видимые поля строки и геометрия. */
export const layerFeatureQuery = (layerId: string, rowId: string) =>
  queryOptions({
    queryKey: gisKeys.feature(layerId, rowId),
    queryFn: () => http.get('/gis/layers/:id/features/:rowId', { params: { id: layerId, rowId } }),
    staleTime: 30_000,
  })

/** Точки «Исследования» на карте (ADR-0217): `request` — JSON спецификации запроса. */
export const explorePointsQuery = (request: string) =>
  queryOptions({
    queryKey: ['explore', 'points', request],
    queryFn: (): Promise<QueryResult> =>
      http.post('/queries/run', { body: { spec: JSON.parse(request) as QuerySpec } }),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 60_000,
  })

/** Текст ошибки сервера для показа; не ошибка API — null. */
export const apiFailureMessage = (error: unknown): string | null =>
  error instanceof ApiError ? error.message : null

export const gisApi = {
  postLayers: (body: ApiBody<'POST /gis/layers'>) => http.post('/gis/layers', { body }),
  getLayers: (id: string) => http.get('/gis/layers/:id', { params: { id } }),
  patchLayers: (id: string, body: ApiBody<'PATCH /gis/layers/:id'>) =>
    http.patch('/gis/layers/:id', { params: { id }, body }),
  getBasemaps: () => http.get('/gis/basemaps'),
  getBasemapsStyleJson: (id: string, query: ApiQuery<'GET /gis/basemaps/:id/style.json'>) =>
    http.get('/gis/basemaps/:id/style.json', { params: { id }, query }),
  postLayersStats: (id: string, body: ApiBody<'POST /gis/layers/:id/stats'>) =>
    http.post('/gis/layers/:id/stats', { params: { id }, body }),
  postMaps: (body: ApiBody<'POST /gis/maps'>) => http.post('/gis/maps', { body }),
  removeObjects: (id: string) => http.delete('/objects/:id', { params: { id } }),
  postObjectsRestore: (id: string) => http.post('/objects/:id/restore', { params: { id } }),
  getDatasetsExportsDownload: (jobId: string) =>
    http.get('/datasets/exports/:jobId/download', { params: { jobId } }),
  postDatasetsExports: (id: string, body: ApiBody<'POST /datasets/:id/exports'>) =>
    http.post('/datasets/:id/exports', { params: { id }, body }),
  patchMaps: (id: string, body: ApiBody<'PATCH /gis/maps/:id'>) =>
    http.patch('/gis/maps/:id', { params: { id }, body }),
}
