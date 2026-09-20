import type {
  AlertCheckResult,
  AlertCreateInput,
  AlertDefinition,
  AlertEventList,
  AlertList,
  AlertListQuery,
  AlertRecord,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/** Запросы алертов на показатели (06-analytics-engine.md §14, ADR-0104). */
export const alertKeys = {
  all: ['alerts'] as const,
  list: (query: Partial<AlertListQuery> = {}) => ['alerts', 'list', query] as const,
  alert: (id: string) => ['alerts', 'alert', id] as const,
  events: (params: Record<string, unknown>) => ['alerts', 'events', params] as const,
}

export const alertsQuery = (query: Partial<AlertListQuery> = {}) =>
  queryOptions({
    queryKey: alertKeys.list(query),
    queryFn: () => http.get<AlertList>('/alerts', { query }),
  })

export const alertQuery = (id: string) =>
  queryOptions({
    queryKey: alertKeys.alert(id),
    queryFn: () => http.get<AlertRecord>(`/alerts/${id}`),
    enabled: id.length > 0,
  })

/** История срабатываний: карточка алерта и отметки на графике показателя. */
export const alertEventsQuery = (params: { alertId?: string; metricId?: string; limit?: number }) =>
  queryOptions({
    queryKey: alertKeys.events(params),
    queryFn: () => http.get<AlertEventList>('/alerts/events', { query: params }),
    enabled: Boolean(params.alertId || params.metricId),
  })

export const alertsApi = {
  create: (input: AlertCreateInput) => http.post<{ id: string }>('/alerts', input),
  update: (id: string, body: { name?: string; definition: AlertDefinition }) =>
    http.put<AlertRecord>(`/alerts/${id}`, body),
  setEnabled: (id: string, enabled: boolean) =>
    http.post<AlertRecord>(`/alerts/${id}/enabled`, { enabled }),
  check: (id: string, dryRun: boolean) =>
    http.post<AlertCheckResult>(`/alerts/${id}/check`, { dryRun }),
}
