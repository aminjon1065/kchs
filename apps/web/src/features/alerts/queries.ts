import type { AlertCreateInput, AlertDefinition } from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import type { ApiQuery } from '~/shared/api/route-types.js'

/** Запросы алертов на показатели (06-analytics-engine.md §14, ADR-0104). */
export const alertKeys = {
  all: ['alerts'] as const,
  list: (query: ApiQuery<'GET /alerts'> = {}) => ['alerts', 'list', query] as const,
  alert: (id: string) => ['alerts', 'alert', id] as const,
  events: (params: Record<string, unknown>) => ['alerts', 'events', params] as const,
}

export const alertsQuery = (query: ApiQuery<'GET /alerts'> = {}) =>
  queryOptions({
    queryKey: alertKeys.list(query),
    queryFn: () => http.get('/alerts', { query }),
  })

export const alertQuery = (id: string) =>
  queryOptions({
    queryKey: alertKeys.alert(id),
    queryFn: () => http.get('/alerts/:id', { params: { id } }),
    enabled: id.length > 0,
  })

/** История срабатываний: карточка алерта и отметки на графике показателя. */
export const alertEventsQuery = (params: { alertId?: string; metricId?: string; limit?: number }) =>
  queryOptions({
    queryKey: alertKeys.events(params),
    queryFn: () => http.get('/alerts/events', { query: params }),
    enabled: Boolean(params.alertId || params.metricId),
  })

export const alertsApi = {
  create: (input: AlertCreateInput) => http.post('/alerts', { body: input }),
  update: (id: string, body: { name?: string; definition: AlertDefinition }) =>
    http.put('/alerts/:id', { params: { id }, body }),
  setEnabled: (id: string, enabled: boolean) =>
    http.post('/alerts/:id/enabled', { params: { id }, body: { enabled } }),
  check: (id: string, dryRun: boolean) =>
    http.post('/alerts/:id/check', { params: { id }, body: { dryRun } }),
}
