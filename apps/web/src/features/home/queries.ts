import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

export const homeApi = {
  putMePreferences: (body: ApiBody<'PUT /me/preferences'>) => http.put('/me/preferences', { body }),
}
