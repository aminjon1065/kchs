import type {
  IntegrationCheckResult,
  SourceCreateInput,
  SourceList,
  SourcePreview,
  SourcePreviewInput,
  SourceRecord,
  SourceRunList,
  SourceRunStarted,
  SourceTableList,
  SourceUpdateInput,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/**
 * Источники датасетов из внешних баз (ADR-0107): подключение живёт в
 * интеграции, выборка и расписание — в источнике. Учётные данные в браузер не
 * приходят: чтение внешней базы всегда идёт через API.
 */
export const sourceKeys = {
  all: ['sources'] as const,
  list: () => ['sources', 'list'] as const,
  runs: (id: string) => ['sources', id, 'runs'] as const,
  tables: (integrationId: string) => ['sources', 'tables', integrationId] as const,
}

const ACTIVE = new Set(['queued', 'running'])

export const sourcesQuery = () =>
  queryOptions({
    queryKey: sourceKeys.list(),
    queryFn: () => http.get<SourceList>('/sources'),
    staleTime: 15_000,
  })

export const sourceRunsQuery = (id: string) =>
  queryOptions({
    queryKey: sourceKeys.runs(id),
    queryFn: () => http.get<SourceRunList>(`/sources/${id}/runs`, { query: { limit: 30 } }),
    enabled: id.length > 0,
    // Пока синхронизация идёт — обновляем журнал
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((run) => ACTIVE.has(run.status)) ? 2000 : false,
  })

export const sourceTablesQuery = (integrationId: string) =>
  queryOptions({
    queryKey: sourceKeys.tables(integrationId),
    queryFn: () => http.get<SourceTableList>(`/sources/integrations/${integrationId}/tables`),
    enabled: integrationId.length > 0,
    retry: false,
    staleTime: 60_000,
  })

export const sourceApi = {
  create: (input: SourceCreateInput) => http.post<SourceRecord>('/sources', input),
  update: (id: string, input: SourceUpdateInput) =>
    http.patch<SourceRecord>(`/sources/${id}`, input),
  preview: (input: SourcePreviewInput) => http.post<SourcePreview>('/sources/preview', input),
  check: (id: string) => http.post<IntegrationCheckResult>(`/sources/${id}/check`),
  sync: (id: string) => http.post<SourceRunStarted>(`/sources/${id}/sync`),
  remove: (id: string) => http.delete<void>(`/objects/${id}`),
}
