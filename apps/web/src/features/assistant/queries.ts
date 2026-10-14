import { http } from '~/shared/api/client.js'
import type { ApiBody, ApiQuery } from '~/shared/api/route-types.js'

export const assistantApi = {
  getThread: (query: ApiQuery<'GET /assistant/thread'>) => http.get('/assistant/thread', { query }),
  postAsk: (body: ApiBody<'POST /assistant/ask'>) => http.post('/assistant/ask', { body }),
  removeThreads: (id: string) => http.delete('/assistant/threads/:id', { params: { id } }),
}
