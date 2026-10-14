import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

export const profileApi = {
  removeMeApiTokens: (id: string) => http.delete('/me/api-tokens/:id', { params: { id } }),
  postMeApiTokens: (body: ApiBody<'POST /me/api-tokens'>) => http.post('/me/api-tokens', { body }),
  removeMeDelegations: (id: string) => http.delete('/me/delegations/:id', { params: { id } }),
  postMeDelegations: (body: ApiBody<'POST /me/delegations'>) =>
    http.post('/me/delegations', { body }),
  getMeMail: () => http.get('/me/mail'),
  postMeMailPassword: () => http.post('/me/mail/password'),
  removeMeMailPassword: () => http.delete('/me/mail/password'),
  removeMeMfa: (body: ApiBody<'DELETE /me/mfa'>) => http.delete('/me/mfa', { body }),
  getMeNotificationPreferences: () => http.get('/me/notification-preferences'),
  getMePresence: () => http.get('/me/presence'),
  putMeNotificationPreferences: (body: ApiBody<'PUT /me/notification-preferences'>) =>
    http.put('/me/notification-preferences', { body }),
  getMePasskeys: () => http.get('/me/passkeys'),
  postMePasskeysOptions: () => http.post('/me/passkeys/options'),
  postMePasskeys: (body: ApiBody<'POST /me/passkeys'>) => http.post('/me/passkeys', { body }),
  removeMePasskeys: (keyId: string) => http.delete('/me/passkeys/:keyId', { params: { keyId } }),
  postMePassword: (body: ApiBody<'POST /me/password'>) => http.post('/me/password', { body }),
  patchMe: (body: ApiBody<'PATCH /me'>) => http.patch('/me', { body }),
  postAuthLogout: () => http.post('/auth/logout'),
  revokeAllSessions: () => http.post('/me/sessions/revoke', { body: { all: true } }),
  revokeSessions: (body: ApiBody<'POST /me/sessions/revoke'>) =>
    http.post('/me/sessions/revoke', { body }),
  getMeTelegram: () => http.get('/me/telegram'),
  postMeTelegramLink: () => http.post('/me/telegram/link'),
  removeMeTelegram: () => http.delete('/me/telegram'),
}

export const meTelegramQuery = () =>
  queryOptions({
    queryKey: ['me', 'telegram'],
    queryFn: () => http.get('/me/telegram'),
  })

export const meSessionsQuery = () =>
  queryOptions({
    queryKey: ['me', 'sessions'],
    queryFn: () => http.get('/me/sessions'),
  })
