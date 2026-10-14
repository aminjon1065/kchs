import { http } from '~/shared/api/client.js'
import type { ApiBody, ApiQuery } from '~/shared/api/route-types.js'

export const documentsMailApi = {
  getMail: (query: ApiQuery<'GET /documents/mail'>) => http.get('/documents/mail', { query }),
  postMailPoll: () => http.post('/documents/mail/poll'),
  postMailReject: (id: string, body: ApiBody<'POST /documents/mail/:id/reject'>) =>
    http.post('/documents/mail/:id/reject', { params: { id }, body }),
}
