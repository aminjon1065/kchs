import type { DirectoryState, DirectorySyncRun, SsoState } from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/** Каталог LDAP/AD и единый вход в администрировании (ADR-0098). */
export const authProviderKeys = {
  directory: ['admin', 'directory'] as const,
  directorySyncs: ['admin', 'directory', 'syncs'] as const,
  sso: ['admin', 'sso'] as const,
}

export const directoryQuery = () =>
  queryOptions({
    queryKey: authProviderKeys.directory,
    queryFn: () => http.get<DirectoryState>('/admin/directory'),
  })

export const directorySyncsQuery = () =>
  queryOptions({
    queryKey: authProviderKeys.directorySyncs,
    queryFn: () =>
      http.get<{ items: DirectorySyncRun[] }>('/admin/directory/syncs', {
        query: { limit: 20 },
      }),
    select: (data) => data.items,
  })

export const ssoQuery = () =>
  queryOptions({
    queryKey: authProviderKeys.sso,
    queryFn: () => http.get<SsoState>('/admin/sso'),
  })
