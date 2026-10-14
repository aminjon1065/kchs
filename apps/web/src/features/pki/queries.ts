import type { PkiAdminCertificateQuery } from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
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
  revokeMine: (id: string, reason?: string) =>
    http.post('/me/certificates/:id/revoke', { params: { id }, body: reason ? { reason } : {} }),
  revoke: (id: string, reason?: string) =>
    http.post('/admin/pki/certificates/:id/revoke', {
      params: { id },
      body: reason ? { reason } : {},
    }),
  init: () => http.post('/admin/pki/init', {}),
}

/** Скачать корневой сертификат — установить его в доверенные (руководство сотрудника). */
export const rootCertificateUrl = () => apiUrl('/pki/root.crt')
export const issuingCertificateUrl = () => apiUrl('/pki/issuing.crt')
