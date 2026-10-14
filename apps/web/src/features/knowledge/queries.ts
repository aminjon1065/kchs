import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

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
    queryFn: () => http.get('/pages/:id', { params: { id } }),
    staleTime: 10_000,
  })

/** Дерево страниц пространства; с `q` — плоский список найденного по названию. */
export const pageTreeQuery = (spaceId: string, q = '') =>
  queryOptions({
    queryKey: knowledgeKeys.tree(spaceId, q),
    queryFn: async () =>
      (await http.get('/knowledge/tree', { query: { spaceId, ...(q ? { q } : {}) } })).items,
    enabled: Boolean(spaceId),
    staleTime: 15_000,
  })

export const pageVersionsQuery = (id: string) =>
  queryOptions({
    queryKey: knowledgeKeys.versions(id),
    queryFn: async () => (await http.get('/pages/:id/versions', { params: { id } })).items,
  })

/** Сравнение версий: `to` пустой — текущий текст страницы. */
export const pageCompareQuery = (id: string, from: string, to: string) =>
  queryOptions({
    queryKey: knowledgeKeys.compare(id, from, to),
    queryFn: () =>
      http.get('/pages/:id/versions/compare', {
        params: { id },
        query: { ...(from ? { from } : {}), ...(to ? { to } : {}) },
      }),
  })

export const knowledgeSearchQuery = (q: string, spaceId: string | null) =>
  queryOptions({
    queryKey: knowledgeKeys.search(q, spaceId),
    queryFn: () => http.get('/knowledge/search', { query: { q, ...(spaceId ? { spaceId } : {}) } }),
    enabled: q.trim().length > 1,
  })

export const knowledgeApi = {
  postPages: (body: ApiBody<'POST /pages'>) => http.post('/pages', { body }),
  getHelp: () => http.get('/knowledge/help'),
  postChartsData: (id: string) => http.post('/charts/:id/data', { params: { id }, body: {} }),
  postMetricsValue: (id: string) => http.post('/metrics/:id/value', { params: { id }, body: {} }),
  getObjectsAcknowledgments: (id: string) =>
    http.get('/objects/:id/acknowledgments', { params: { id } }),
  postObjectsAcknowledgmentsAcknowledge: (id: string) =>
    http.post('/objects/:id/acknowledgments/acknowledge', { params: { id }, body: {} }),
  postPagesAcknowledgments: (id: string, body: ApiBody<'POST /pages/:id/acknowledgments'>) =>
    http.post('/pages/:id/acknowledgments', { params: { id }, body }),
  patchPages: (id: string, body: ApiBody<'PATCH /pages/:id'>) =>
    http.patch('/pages/:id', { params: { id }, body }),
  postPagesPublish: (id: string, body: ApiBody<'POST /pages/:id/publish'>) =>
    http.post('/pages/:id/publish', { params: { id }, body }),
  postPagesVersions: (id: string, body: ApiBody<'POST /pages/:id/versions'>) =>
    http.post('/pages/:id/versions', { params: { id }, body }),
  postPagesVersionsRestore: (id: string, versionId: string) =>
    http.post('/pages/:id/versions/:versionId/restore', { params: { id, versionId } }),
}
