import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

export const gisStyleEditorApi = {
  postQueriesRun: (body: ApiBody<'POST /queries/run'>) => http.post('/queries/run', { body }),
  patchLayers: (id: string, body: ApiBody<'PATCH /gis/layers/:id'>) =>
    http.patch('/gis/layers/:id', { params: { id }, body }),
}
