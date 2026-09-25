import type {
  ReportRecord,
  ReportRunList,
  ReportSchedule,
  ReportTemplateList,
  ReportVersionList,
} from '@kchs/contracts'
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
    queryFn: async () => (await http.get<ReportRunList>(`/reports/${id}/runs`)).items,
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status === 'queued' || run.status === 'running')
        ? 2000
        : 15_000,
  })

export const reportScheduleQuery = (id: string) =>
  queryOptions({
    queryKey: reportKeys.schedule(id),
    queryFn: async () =>
      (await http.get<{ schedule: ReportSchedule | null }>(`/reports/${id}/schedule`)).schedule,
  })

/** Версии шаблона отчёта (ADR-0164). */
export const reportVersionsQuery = (id: string) =>
  queryOptions({
    queryKey: reportKeys.versions(id),
    queryFn: async () => (await http.get<ReportVersionList>(`/reports/${id}/versions`)).items,
  })

/** Библиотека шаблонов: встроенные и отчёты, отмеченные шаблоном. */
export const reportTemplatesQuery = () =>
  queryOptions({
    queryKey: reportKeys.templates,
    queryFn: async () => (await http.get<ReportTemplateList>('/reports/templates')).items,
    staleTime: 60_000,
  })

export const reportLibraryApi = {
  saveVersion: (id: string, label: string | null) =>
    http.post<{ number: number }>(`/reports/${id}/versions`, { label }),
  restore: (id: string, versionId: string) =>
    http.post<ReportRecord>(`/reports/${id}/versions/${versionId}/restore`),
  setTemplate: (id: string, template: boolean) =>
    http.post<ReportRecord>(`/reports/${id}/template`, { template }),
}
