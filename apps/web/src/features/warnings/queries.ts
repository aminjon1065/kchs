import { queryOptions } from '@tanstack/react-query'
import { ApiError, http } from '~/shared/api/client.js'
import type { ApiBody, ApiQuery } from '~/shared/api/route-types.js'

/**
 * Запросы предупреждений CAP (ADR-0202). Карточка — под `['object', id, …]`:
 * realtime ядра сбрасывает её вместе с маршрутом объекта.
 */
export const warningKeys = {
  all: ['warnings'] as const,
  list: (query: ApiQuery<'GET /warnings'> = {}) => ['warnings', 'list', query] as const,
  settings: ['warnings', 'settings'] as const,
  sources: ['warnings', 'sources'] as const,
  warning: (id: string) => ['object', id, 'warning'] as const,
}

export const warningsQuery = (query: ApiQuery<'GET /warnings'> = {}) =>
  queryOptions({
    queryKey: warningKeys.list(query),
    queryFn: () => http.get('/warnings', { query }),
  })

export const warningSettingsQuery = () =>
  queryOptions({
    queryKey: warningKeys.settings,
    queryFn: () => http.get('/warnings/settings'),
    staleTime: 5 * 60_000,
  })

export const warningSourcesQuery = (enabled: boolean) =>
  queryOptions({
    queryKey: warningKeys.sources,
    queryFn: () => http.get('/warnings/sources', { query: { limit: 50 } }),
    enabled,
  })

export const warningQuery = (id: string) =>
  queryOptions({
    queryKey: warningKeys.warning(id),
    queryFn: () => http.get('/warnings/:id', { params: { id } }),
  })

/** Справочник территорий для выбора области: тот же адрес, что у карты. */
export const warningTerritoriesQuery = () =>
  queryOptions({
    queryKey: ['warnings', 'territories'] as const,
    queryFn: async () => (await http.get('/territories')).items,
    staleTime: 10 * 60_000,
  })

export const warningsApi = {
  create: (body: ApiBody<'POST /warnings'>) => http.post('/warnings', { body }),
  fromMessage: (rowId: string) => http.post('/warnings/from-message', { body: { rowId } }),
  update: (id: string, body: ApiBody<'PUT /warnings/:id'>) =>
    http.put('/warnings/:id', { params: { id }, body }),
  submit: (id: string) => http.post('/warnings/:id/submit', { params: { id } }),
  supersede: (id: string, msgType: 'Update' | 'Cancel') =>
    http.post('/warnings/:id/supersede', { params: { id }, body: { msgType } }),
}

/** Текст ошибки API для уведомления; прочее — общий текст вызывающего. */
export const errorText = (error: unknown, fallback: string): string =>
  error instanceof ApiError ? error.message : fallback
