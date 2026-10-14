import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

export const notificationsApi = {
  markAllRead: () => http.post('/notifications/read', { body: { all: true } }),
  markRead: (body: ApiBody<'POST /notifications/read'>) =>
    http.post('/notifications/read', { body }),
}
