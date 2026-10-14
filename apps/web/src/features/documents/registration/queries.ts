import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

export const documentsRegistrationApi = {
  get: (id: string) => http.get('/documents/:id', { params: { id } }),
  postAssistClassify: (id: string) =>
    http.post('/documents/:id/assist/classify', { params: { id } }),
  postAssistExtract: (id: string) => http.post('/documents/:id/assist/extract', { params: { id } }),
  post: (body: ApiBody<'POST /documents'>) => http.post('/documents', { body }),
  postVersions: (id: string, body: ApiBody<'POST /documents/:id/versions'>) =>
    http.post('/documents/:id/versions', { params: { id }, body }),
  patch: (id: string, body: ApiBody<'PATCH /documents/:id'>) =>
    http.patch('/documents/:id', { params: { id }, body }),
  postRegister: (id: string) => http.post('/documents/:id/register', { params: { id }, body: {} }),
}
