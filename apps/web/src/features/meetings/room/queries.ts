import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

export const meetingsRoomApi = {
  postRecordingsStop: (id: string) => http.post('/recordings/:id/stop', { params: { id } }),
  postRecordingStart: (id: string) =>
    http.post('/meetings/:id/recording/start', { params: { id } }),
  postObjectsDiscussionMessages: (
    id: string,
    body: ApiBody<'POST /objects/:id/discussion/messages'>,
  ) => http.post('/objects/:id/discussion/messages', { params: { id }, body }),
}
