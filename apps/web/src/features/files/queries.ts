import { http } from '~/shared/api/client.js'
import type { ApiBody, ApiQuery } from '~/shared/api/route-types.js'

export const filesApi = {
  postFolders: (body: ApiBody<'POST /folders'>) => http.post('/folders', { body }),
  removeObject: (id: string) => http.delete('/objects/:id', { params: { id } }),
  restoreObject: (id: string) => http.post('/objects/:id/restore', { params: { id } }),
  updateObject: (id: string, body: ApiBody<'PATCH /objects/:id'>) =>
    http.patch('/objects/:id', { params: { id }, body }),
  getDownload: (id: string, query: ApiQuery<'GET /files/:id/download'>) =>
    http.get('/files/:id/download', { params: { id }, query }),
  postDocumentsWatermarked: (body: ApiBody<'POST /documents/watermarked'>) =>
    http.post('/documents/watermarked', { body }),
  getDocumentsRendersDownload: (id: string) =>
    http.get('/documents/renders/:id/download', { params: { id } }),
  postVersionsRestore: (
    id: string,
    versionId: string,
    body: ApiBody<'POST /files/:id/versions/:versionId/restore'>,
  ) => http.post('/files/:id/versions/:versionId/restore', { params: { id, versionId }, body }),
}
