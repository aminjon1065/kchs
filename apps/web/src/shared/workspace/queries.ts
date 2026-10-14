import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

export const workspaceApi = {
  update: (id: string, body: ApiBody<'PATCH /workspaces/:id'>) =>
    http.patch('/workspaces/:id', { params: { id }, body }),
  remove: (id: string) => http.delete('/objects/:id', { params: { id } }),
  restore: (id: string) => http.post('/objects/:id/restore', { params: { id } }),
  create: (body: ApiBody<'POST /workspaces'>) => http.post('/workspaces', { body }),
  state: () => http.get('/me/workspace-state'),
}
