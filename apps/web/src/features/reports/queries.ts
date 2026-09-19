import type { ReportRunList, ReportSchedule } from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/** Ключи кэша отчёта: снимок, запуски, расписание. */
export const reportKeys = {
  report: (id: string) => ['report', id] as const,
  runs: (id: string) => ['report', id, 'runs'] as const,
  schedule: (id: string) => ['report', id, 'schedule'] as const,
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
