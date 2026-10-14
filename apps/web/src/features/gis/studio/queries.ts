import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import type { ApiBody, ApiQuery } from '~/shared/api/route-types.js'

export const gisStudioApi = {
  getLayers: (id: string) => http.get('/gis/layers/:id', { params: { id } }),
  postDatasetsRowsQuery: (id: string, body: ApiBody<'POST /datasets/:id/rows/query'>) =>
    http.post('/datasets/:id/rows/query', { params: { id }, body }),
  getLayersFeatures: (id: string, query: ApiQuery<'GET /gis/layers/:id/features'>) =>
    http.get('/gis/layers/:id/features', { params: { id }, query }),
  getTerritoriesGeometry: (id: string) =>
    http.get('/gis/territories/:id/geometry', { params: { id }, query: { zoom: 10 } }),
  postQueriesRun: (body: ApiBody<'POST /queries/run'>) => http.post('/queries/run', { body }),
}

/** Адрес точки: ключ — координаты с точностью до метра. */
export const geocodeReverseQuery = (lon: number, lat: number) =>
  queryOptions({
    queryKey: ['geocode', 'reverse', lon.toFixed(5), lat.toFixed(5)],
    queryFn: () => http.get('/gis/geocode/reverse', { query: { lon, lat } }),
  })

export const geocodeQuery = (query: ApiQuery<'GET /gis/geocode'>) =>
  queryOptions({
    queryKey: ['geocode', query.q, query.limit],
    queryFn: () => http.get('/gis/geocode', { query }),
  })
