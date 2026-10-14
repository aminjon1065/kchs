import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

export const gisChoroplethApi = {
  postAnalysesPreview: (body: ApiBody<'POST /analyses/preview'>) =>
    http.post('/analyses/preview', { body }),
  postLayers: (body: ApiBody<'POST /gis/layers'>) => http.post('/gis/layers', { body }),
  postMaps: (body: ApiBody<'POST /gis/maps'>) => http.post('/gis/maps', { body }),
  postAnalyses: (body: ApiBody<'POST /analyses'>) => http.post('/analyses', { body }),
  getAnalyses: (id: string) => http.get('/analyses/:id', { params: { id } }),
  getJobs: (id: string) => http.get('/jobs/:id', { params: { id } }),
  getMaps: (id: string) => http.get('/gis/maps/:id', { params: { id } }),
  patchMaps: (id: string, body: ApiBody<'PATCH /gis/maps/:id'>) =>
    http.patch('/gis/maps/:id', { params: { id }, body }),
}
