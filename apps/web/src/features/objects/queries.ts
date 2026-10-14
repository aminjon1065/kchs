import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

export const objectsApi = {
  updateObject: (id: string, body: ApiBody<'PATCH /objects/:id'>) =>
    http.patch('/objects/:id', { params: { id }, body }),
  removeObject: (id: string) => http.delete('/objects/:id', { params: { id } }),
  restoreObject: (id: string) => http.post('/objects/:id/restore', { params: { id } }),
}
