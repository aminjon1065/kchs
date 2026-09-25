import type { HelpLink } from '@kchs/contracts'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useWorkspace } from '~/app/workspace/store.js'
import { http } from '~/shared/api/client.js'

/** Страница «Справки» сотрудника (N88): на его языке, без перевода — русская. */
export const helpQuery = () =>
  queryOptions({
    queryKey: ['knowledge', 'help'] as const,
    queryFn: async () => (await http.get<HelpLink>('/knowledge/help')).page,
    staleTime: 5 * 60_000,
  })

/**
 * Открыть справку вкладкой страницы базы знаний; `null` — справки нет (страница не
 * выбрана или сотруднику не видна), и пункт не показывается.
 */
export function useOpenHelp(): (() => void) | null {
  const openTab = useWorkspace((s) => s.openTab)
  const { data: page } = useQuery(helpQuery())
  const id = page?.id
  const title = page?.title
  return useMemo(
    () =>
      id && title
        ? () =>
            openTab({ kind: 'object', objectId: id, objectType: 'page', title, mode: 'permanent' })
        : null,
    [id, title, openTab],
  )
}
