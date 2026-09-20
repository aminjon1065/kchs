import type {
  PipelineCreateInput,
  PipelineDefinition,
  PipelineList,
  PipelineRecord,
  PipelineRunList,
  PipelineRunStarted,
  PipelineUpdateInput,
  PipelineValidateResult,
  QueryResult,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/**
 * Пайплайны преобразований (06-analytics-engine.md §16, ADR-0106): цепочка
 * шагов над датасетами. Предпросмотр и прогон считаются на сервере с правами
 * смотрящего — клиент только показывает результат.
 */
export const pipelineKeys = {
  all: ['pipelines'] as const,
  list: () => ['pipelines', 'list'] as const,
  one: (id: string) => ['pipelines', id] as const,
  runs: (id: string) => ['pipelines', id, 'runs'] as const,
}

const ACTIVE = new Set(['queued', 'running'])

export const pipelinesQuery = () =>
  queryOptions({
    queryKey: pipelineKeys.list(),
    queryFn: () => http.get<PipelineList>('/pipelines'),
    staleTime: 15_000,
  })

export const pipelineQuery = (id: string) =>
  queryOptions({
    queryKey: pipelineKeys.one(id),
    queryFn: () => http.get<PipelineRecord>(`/pipelines/${id}`),
    enabled: id.length > 0,
  })

export const pipelineRunsQuery = (id: string) =>
  queryOptions({
    queryKey: pipelineKeys.runs(id),
    queryFn: () => http.get<PipelineRunList>(`/pipelines/${id}/runs`, { query: { limit: 30 } }),
    enabled: id.length > 0,
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((run) => ACTIVE.has(run.status)) ? 2000 : false,
  })

export const pipelineApi = {
  create: (input: PipelineCreateInput) => http.post<PipelineRecord>('/pipelines', input),
  update: (id: string, input: PipelineUpdateInput) =>
    http.patch<PipelineRecord>(`/pipelines/${id}`, input),
  validate: (definition: PipelineDefinition) =>
    http.post<PipelineValidateResult>('/pipelines/validate', { definition }),
  preview: (definition: PipelineDefinition, untilStepId: string | undefined, limit: number) =>
    http.post<QueryResult>('/pipelines/preview', {
      definition,
      ...(untilStepId ? { untilStepId } : {}),
      limit,
    }),
  run: (id: string) => http.post<PipelineRunStarted>(`/pipelines/${id}/run`),
  remove: (id: string) => http.delete<void>(`/objects/${id}`),
}
