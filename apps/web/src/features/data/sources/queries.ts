import type {
  FeedPreview,
  FeedPreviewInput,
  FeedSourceCreateInput,
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
 * Источники датасетов из внешних баз (ADR-0107) и ленты по адресу (ADR-0132):
 * подключение и секреты живут в интеграции, выборка или разбор ленты и
 * расписание — в источнике. Учётные данные в браузер не приходят: чтение
 * внешней базы и ленты всегда идёт через API.
 */
export const sourceKeys = {
  all: ['sources'] as const,
  list: () => ['sources', 'list'] as const,
  one: (id: string) => ['sources', id] as const,
  runs: (id: string) => ['sources', id, 'runs'] as const,
  tables: (integrationId: string) => ['sources', 'tables', integrationId] as const,
}

export const sourceQuery = (id: string) =>
  queryOptions({
    queryKey: sourceKeys.one(id),
    queryFn: () => http.get<SourceRecord>(`/sources/${id}`),
    enabled: id.length > 0,
  })

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
  createFeed: (input: FeedSourceCreateInput) => http.post<SourceRecord>('/sources/feeds', input),
  previewFeed: (input: FeedPreviewInput) => http.post<FeedPreview>('/sources/feed/preview', input),
  update: (id: string, input: SourceUpdateInput) =>
    http.patch<SourceRecord>(`/sources/${id}`, input),
  preview: (input: SourcePreviewInput) => http.post<SourcePreview>('/sources/preview', input),
  check: (id: string) => http.post<IntegrationCheckResult>(`/sources/${id}/check`),
  sync: (id: string) => http.post<SourceRunStarted>(`/sources/${id}/sync`),
  remove: (id: string) => http.delete<void>(`/objects/${id}`),
}
