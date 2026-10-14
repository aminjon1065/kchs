import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

export const authApi = {
  login: (body: ApiBody<'POST /auth/login'>) => http.post('/auth/login', { body, anonymous: true }),
  postMfaVerify: (body: ApiBody<'POST /auth/mfa/verify'>) =>
    http.post('/auth/mfa/verify', { body, anonymous: true }),
  postSsoStart: () => http.post('/auth/sso/start', { anonymous: true }),
  postPasskeyOptions: () => http.post('/auth/passkey/options', { anonymous: true }),
  postPasskeyVerify: (body: ApiBody<'POST /auth/passkey/verify'>) =>
    http.post('/auth/passkey/verify', { body, anonymous: true }),
  postMfaPasskeyOptions: () => http.post('/auth/mfa/passkey/options', { anonymous: true }),
  postMfaPasskeyVerify: (body: ApiBody<'POST /auth/mfa/passkey/verify'>) =>
    http.post('/auth/mfa/passkey/verify', { body, anonymous: true }),
  postPasswordReset: (body: ApiBody<'POST /auth/password-reset'>) =>
    http.post('/auth/password-reset', { body, anonymous: true }),
  logout: () => http.post('/auth/logout'),
  postMeMfaSetup: () => http.post('/me/mfa/setup'),
  postMeMfaEnable: (body: ApiBody<'POST /me/mfa/enable'>) => http.post('/me/mfa/enable', { body }),
  postMePassword: (body: ApiBody<'POST /me/password'>) => http.post('/me/password', { body }),
  postPasswordResetConfirm: (body: ApiBody<'POST /auth/password-reset/confirm'>) =>
    http.post('/auth/password-reset/confirm', { body }),
}

export const methodsQuery = () =>
  queryOptions({
    queryKey: ['auth', 'methods'],
    queryFn: () => http.get('/auth/methods', { anonymous: true }),
  })
