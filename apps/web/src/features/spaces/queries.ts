import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

export const spacesApi = {
  /** В архив или из архива: пространство только для чтения. */
  setArchived: (id: string, archived: boolean) =>
    http.post(`/spaces/:id/${archived ? 'archive' : 'unarchive'}` as const, { params: { id } }),
  create: (body: ApiBody<'POST /spaces'>) => http.post('/spaces', { body }),
  remove: (id: string) => http.delete('/spaces/:id', { params: { id } }),
  postUnarchive: (id: string) => http.post('/spaces/:id/unarchive', { params: { id } }),
  update: (id: string, body: ApiBody<'PATCH /spaces/:id'>) =>
    http.patch('/spaces/:id', { params: { id }, body }),
  postMembers: (id: string, body: ApiBody<'POST /spaces/:id/members'>) =>
    http.post('/spaces/:id/members', { params: { id }, body }),
  putMembers: (id: string, userId: string, body: ApiBody<'PUT /spaces/:id/members/:userId'>) =>
    http.put('/spaces/:id/members/:userId', { params: { id, userId }, body }),
  removeMembers: (id: string, userId: string) =>
    http.delete('/spaces/:id/members/:userId', { params: { id, userId } }),
}
