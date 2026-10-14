import type {
  PkiAdminCertificateQuery,
  PkiEnrollInput,
  PkiPurpose,
  PkiRotateInput,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { ApiError, http } from '~/shared/api/client.js'
import { apiUrl } from '~/shared/api/link.js'

/** УЦ Комитета (ADR-0218): состояние, свои сертификаты, сертификаты сотрудников. */
export const pkiKeys = {
  status: ['pki', 'status'] as const,
  mine: ['pki', 'mine'] as const,
  all: (query: PkiAdminCertificateQuery) => ['pki', 'all', query] as const,
}

export const pkiStatusQuery = () =>
  queryOptions({ queryKey: pkiKeys.status, queryFn: () => http.get('/pki/status') })

export const myCertificatesQuery = () =>
  queryOptions({ queryKey: pkiKeys.mine, queryFn: () => http.get('/me/certificates') })

export const allCertificatesQuery = (query: PkiAdminCertificateQuery) =>
  queryOptions({
    queryKey: pkiKeys.all(query),
    queryFn: () => http.get('/admin/pki/certificates', { query }),
  })

export const pkiApi = {
  challenge: (purpose: PkiPurpose) =>
    http.post('/me/certificates/challenge', { body: { purpose } }),
  enroll: (body: PkiEnrollInput) => http.post('/me/certificates', { body }),
  revokeMine: (id: string, reason?: string) =>
    http.post('/me/certificates/:id/revoke', { params: { id }, body: reason ? { reason } : {} }),
  revoke: (id: string, reason?: string) =>
    http.post('/admin/pki/certificates/:id/revoke', {
      params: { id },
      body: reason ? { reason } : {},
    }),
  init: () => http.post('/admin/pki/init', {}),
  rotate: (body: PkiRotateInput) => http.post('/admin/pki/rotate', { body }),
}

/** Понятная причина отказа API (ошибка поля или сообщение); прочие ошибки — `null`. */
export function apiErrorMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  return Object.values(error.fieldErrors())[0] ?? error.message
}

/** Скачать корневой сертификат — установить его в доверенные (руководство сотрудника). */
export const rootCertificateUrl = () => apiUrl('/pki/root.crt')
/** Сертификат текущего выпускающего: после смены ключа — по его адресу (ADR-0224). */
export const issuingCertificateUrl = (path = 'issuing') => {
  const generation = /^issuers\/([0-9a-f]{16})$/.exec(path)?.[1]
  return generation
    ? apiUrl('/pki/issuers/:generation.crt', { params: { generation } })
    : apiUrl('/pki/issuing.crt')
}
