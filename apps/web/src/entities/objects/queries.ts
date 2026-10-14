import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

/**
 * Действия над объектом реестра из панели контекста и разбора адреса: избранное, метки,
 * вложения, обсуждение. Ключи кэша — под `['object', id, …]`.
 */
export const objectApi = {
  addFavorite: (id: string) => http.put('/objects/:id/favorite', { params: { id } }),
  removeFavorite: (id: string) => http.delete('/objects/:id/favorite', { params: { id } }),
  addTag: (id: string, body: ApiBody<'POST /objects/:id/tags'>) =>
    http.post('/objects/:id/tags', { params: { id }, body }),
  removeTag: (id: string, tagId: string) =>
    http.delete('/objects/:id/tags/:tagId', { params: { id, tagId } }),
  removeAttachment: (id: string, targetId: string) =>
    http.delete('/objects/:id/links/:targetId/:kind', {
      params: { id, targetId, kind: 'attachment' },
    }),
  postMessage: (id: string, body: ApiBody<'POST /objects/:id/discussion/messages'>) =>
    http.post('/objects/:id/discussion/messages', { params: { id }, body }),
  get: (id: string) => http.get('/objects/:id', { params: { id } }),
}

export const similarObjectsQuery = (id: string) =>
  queryOptions({
    queryKey: ['object', id, 'similar'],
    queryFn: () => http.get('/objects/:id/similar', { params: { id }, query: { limit: 6 } }),
  })

export const lineageQuery = (id: string) =>
  queryOptions({
    queryKey: ['object', id, 'lineage'],
    queryFn: () => http.get('/objects/:id/lineage', { params: { id }, query: { depth: 3 } }),
  })
