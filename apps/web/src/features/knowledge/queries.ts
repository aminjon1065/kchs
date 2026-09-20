import type {
  PageRecord,
  PageSearchResult,
  PageTreeNode,
  PageVersionCompareResult,
  PageVersionRecord,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/**
 * Ключи кэша базы знаний (ADR-0095). Всё, что принадлежит странице, — под
 * `['object', id, …]`: realtime ядра инвалидирует их при изменении объекта.
 */
export const knowledgeKeys = {
  tree: (spaceId: string, q: string) => ['knowledge', 'tree', spaceId, q] as const,
  search: (q: string, spaceId: string | null) => ['knowledge', 'search', q, spaceId] as const,
  page: (id: string) => ['object', id, 'page'] as const,
  versions: (id: string) => ['object', id, 'page-versions'] as const,
  compare: (id: string, from: string, to: string) =>
    ['object', id, 'page-compare', from, to] as const,
  acknowledgments: (id: string) => ['object', id, 'acknowledgments'] as const,
}

export const pageQuery = (id: string) =>
  queryOptions({
    queryKey: knowledgeKeys.page(id),
    queryFn: () => http.get<PageRecord>(`/pages/${id}`),
    staleTime: 10_000,
  })

/** Дерево страниц пространства; с `q` — плоский список найденного по названию. */
export const pageTreeQuery = (spaceId: string, q = '') =>
  queryOptions({
    queryKey: knowledgeKeys.tree(spaceId, q),
    queryFn: async () =>
      (
        await http.get<{ items: PageTreeNode[] }>('/knowledge/tree', {
          query: { spaceId, ...(q ? { q } : {}) },
        })
      ).items,
    enabled: Boolean(spaceId),
    staleTime: 15_000,
  })

export const pageVersionsQuery = (id: string) =>
  queryOptions({
    queryKey: knowledgeKeys.versions(id),
    queryFn: async () =>
      (await http.get<{ items: PageVersionRecord[] }>(`/pages/${id}/versions`)).items,
  })

/** Сравнение версий: `to` пустой — текущий текст страницы. */
export const pageCompareQuery = (id: string, from: string, to: string) =>
  queryOptions({
    queryKey: knowledgeKeys.compare(id, from, to),
    queryFn: () =>
      http.get<PageVersionCompareResult>(`/pages/${id}/versions/compare`, {
        query: { ...(from ? { from } : {}), ...(to ? { to } : {}) },
      }),
  })

export const knowledgeSearchQuery = (q: string, spaceId: string | null) =>
  queryOptions({
    queryKey: knowledgeKeys.search(q, spaceId),
    queryFn: () =>
      http.get<PageSearchResult>('/knowledge/search', {
        query: { q, ...(spaceId ? { spaceId } : {}) },
      }),
    enabled: q.trim().length > 1,
  })
