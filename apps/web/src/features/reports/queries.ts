import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/** Ключи кэша отчёта: снимок, запуски, расписание. */
export const reportKeys = {
  report: (id: string) => ['report', id] as const,
  runs: (id: string) => ['report', id, 'runs'] as const,
  schedule: (id: string) => ['report', id, 'schedule'] as const,
  versions: (id: string) => ['report', id, 'versions'] as const,
  templates: ['report', 'templates'] as const,
}

/**
 * История запусков обновляется сама: пока идёт рендер — часто, иначе — изредка
 * (запуски по расписанию ставит планировщик, экран о них не знает).
 */
export const reportRunsQuery = (id: string) =>
  queryOptions({
    queryKey: reportKeys.runs(id),
    queryFn: async () => (await http.get('/reports/:id/runs', { params: { id } })).items,
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status === 'queued' || run.status === 'running')
        ? 2000
        : 15_000,
  })

export const reportScheduleQuery = (id: string) =>
  queryOptions({
    queryKey: reportKeys.schedule(id),
    queryFn: async () => (await http.get('/reports/:id/schedule', { params: { id } })).schedule,
  })

/** Версии шаблона отчёта (ADR-0164). */
export const reportVersionsQuery = (id: string) =>
  queryOptions({
    queryKey: reportKeys.versions(id),
    queryFn: async () => (await http.get('/reports/:id/versions', { params: { id } })).items,
  })

/** Библиотека шаблонов: встроенные и отчёты, отмеченные шаблоном. */
export const reportTemplatesQuery = () =>
  queryOptions({
    queryKey: reportKeys.templates,
    queryFn: async () => (await http.get('/reports/templates')).items,
    staleTime: 60_000,
  })

export const reportLibraryApi = {
  saveVersion: (id: string, label: string | null) =>
    http.post('/reports/:id/versions', { params: { id }, body: { label } }),
  restore: (id: string, versionId: string) =>
    http.post('/reports/:id/versions/:versionId/restore', { params: { id, versionId } }),
  setTemplate: (id: string, template: boolean) =>
    http.post('/reports/:id/template', { params: { id }, body: { template } }),
}
