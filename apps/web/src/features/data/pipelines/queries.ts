import type { PipelineCreateInput, PipelineDefinition, PipelineUpdateInput } from '@kchs/contracts'
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
    queryFn: () => http.get('/pipelines'),
    staleTime: 15_000,
  })

export const pipelineQuery = (id: string) =>
  queryOptions({
    queryKey: pipelineKeys.one(id),
    queryFn: () => http.get('/pipelines/:id', { params: { id } }),
    enabled: id.length > 0,
  })

export const pipelineRunsQuery = (id: string) =>
  queryOptions({
    queryKey: pipelineKeys.runs(id),
    queryFn: () => http.get('/pipelines/:id/runs', { params: { id }, query: { limit: 30 } }),
    enabled: id.length > 0,
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((run) => ACTIVE.has(run.status)) ? 2000 : false,
  })

export const pipelineApi = {
  create: (input: PipelineCreateInput) => http.post('/pipelines', { body: input }),
  update: (id: string, input: PipelineUpdateInput) =>
    http.patch('/pipelines/:id', { params: { id }, body: input }),
  validate: (definition: PipelineDefinition) =>
    http.post('/pipelines/validate', { body: { definition } }),
  preview: (definition: PipelineDefinition, untilStepId: string | undefined, limit: number) =>
    http.post('/pipelines/preview', {
      body: {
        definition,
        ...(untilStepId ? { untilStepId } : {}),
        limit,
      },
    }),
  run: (id: string) => http.post('/pipelines/:id/run', { params: { id } }),
  remove: (id: string) => http.delete('/objects/:id', { params: { id } }),
}
