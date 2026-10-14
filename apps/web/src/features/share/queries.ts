import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

export const shareApi = {
  postOpen: (token: string, body: ApiBody<'POST /share/:token/open'>) =>
    http.post('/share/:token/open', { params: { token }, body, anonymous: true }),
  getObjects: (id: string) => http.get('/objects/:id', { params: { id } }),
  getFiles: (id: string) => http.get('/files/:id', { params: { id } }),
  getFilesDownload: (id: string) => http.get('/files/:id/download', { params: { id } }),
}
