import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/** Факсимиле сотрудника для администратора (ADR-0198): только состояние, без картинки. */
export const userFacsimileKey = (userId: string) => ['users', userId, 'facsimile'] as const

export const userFacsimileQuery = (userId: string) =>
  queryOptions({
    queryKey: userFacsimileKey(userId),
    queryFn: () => http.get('/users/:id/facsimile', { params: { id: userId } }),
  })

export const replaceUserFacsimile = (userId: string, png: string) =>
  http.put('/users/:id/facsimile', { params: { id: userId }, body: { png } })

export const removeUserFacsimile = (userId: string) =>
  http.delete('/users/:id/facsimile', { params: { id: userId } })
