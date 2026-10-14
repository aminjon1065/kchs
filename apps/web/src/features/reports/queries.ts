import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import type { ApiBody, ApiQuery } from '~/shared/api/route-types.js'

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

export const reportsApi = {
  create: (body: ApiBody<'POST /reports'>) => http.post('/reports', { body }),
  getImages: (id: string, fileId: string) =>
    http.get('/reports/:id/images/:fileId', { params: { id, fileId } }),
  getFiles: (id: string, query: ApiQuery<'GET /reports/:id/files'>) =>
    http.get('/reports/:id/files', { params: { id }, query }),
  getRunsDownload: (runId: string, query: ApiQuery<'GET /reports/runs/:runId/download'>) =>
    http.get('/reports/runs/:runId/download', { params: { runId }, query }),
  patchObjects: (id: string, body: ApiBody<'PATCH /objects/:id'>) =>
    http.patch('/objects/:id', { params: { id }, body }),
  removeObjects: (id: string) => http.delete('/objects/:id', { params: { id } }),
  postObjectsRestore: (id: string) => http.post('/objects/:id/restore', { params: { id } }),
  postRuns: (id: string, body: ApiBody<'POST /reports/:id/runs'>) =>
    http.post('/reports/:id/runs', { params: { id }, body }),
  postDocument: (id: string, body: ApiBody<'POST /reports/:id/document'>) =>
    http.post('/reports/:id/document', { params: { id }, body }),
  putSchedule: (id: string, body: ApiBody<'PUT /reports/:id/schedule'>) =>
    http.put('/reports/:id/schedule', { params: { id }, body }),
  removeSchedule: (id: string) => http.delete('/reports/:id/schedule', { params: { id } }),
  postScheduleRun: (id: string) => http.post('/reports/:id/schedule/run', { params: { id } }),
}
