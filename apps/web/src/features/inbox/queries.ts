import { http } from '~/shared/api/client.js'
import type { ApiBody, ApiQuery } from '~/shared/api/route-types.js'

export const inboxApi = {
  list: (query: ApiQuery<'GET /inbox'>) => http.get('/inbox', { query }),
  postSnooze: (id: string, body: ApiBody<'POST /inbox/:id/snooze'>) =>
    http.post('/inbox/:id/snooze', { params: { id }, body }),
  postBulk: (body: ApiBody<'POST /inbox/bulk'>) => http.post('/inbox/bulk', { body }),
  postAct: (id: string, body: ApiBody<'POST /inbox/:id/act'>) =>
    http.post('/inbox/:id/act', { params: { id }, body }),
}
