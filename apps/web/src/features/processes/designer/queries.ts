import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

export const processesDesignerApi = {
  postProcessDefinitionsValidate: (body: ApiBody<'POST /process-definitions/validate'>) =>
    http.post('/process-definitions/validate', { body }),
  putProcessDefinitionsDraft: (key: string, body: ApiBody<'PUT /process-definitions/:key/draft'>) =>
    http.put('/process-definitions/:key/draft', { params: { key }, body }),
  postProcessDefinitionsPublish: (key: string) =>
    http.post('/process-definitions/:key/publish', { params: { key } }),
  removeProcessDefinitionsDraft: (key: string) =>
    http.delete('/process-definitions/:key/draft', { params: { key } }),
  getProcessDefinitionsVersions: (key: string, version: number) =>
    http.get('/process-definitions/:key/versions/:version', { params: { key, version } }),
  postProcessDefinitionsPreview: (body: ApiBody<'POST /process-definitions/preview'>) =>
    http.post('/process-definitions/preview', { body }),
}
