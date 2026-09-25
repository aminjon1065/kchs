import type { Branding } from '@kchs/contracts'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useT } from '~/app/i18n.js'
import { http } from './client.js'

/**
 * Брендирование установки (15-admin-operations.md §1): название, логотип и
 * акцент нужны и до входа, поэтому запрос публичный и живёт дольше обычного.
 */
export function brandingQuery() {
  return {
    queryKey: ['branding'] as const,
    queryFn: () => http.get<Branding>('/branding'),
    staleTime: 5 * 60_000,
  }
}

/** Акцент и заголовок окна — из брендирования; без него всё как в дизайн-системе. */
export function useBranding(): Branding | undefined {
  const t = useT()
  const { data } = useQuery(brandingQuery())
  useEffect(() => {
    const root = document.documentElement
    if (!data || data.accent === 'blue') delete root.dataset.accent
    else root.dataset.accent = data.accent
    const product = t('common.appName')
    const title = data?.shortName || data?.name
    document.title = title ? `${title} — ${product}` : product
  }, [data, t])
  return data
}
