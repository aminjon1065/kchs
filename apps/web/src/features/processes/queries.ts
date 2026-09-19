import type { PrincipalRef } from '@kchs/contracts'
import type {
  ProcessCatalog,
  ProcessDefinitionDetails,
  ProcessDefinitionSummary,
  ProcessInstanceSummary,
  ProcessInstanceView,
} from '@kchs/process'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/**
 * Маршруты объекта (API движка процессов, ADR-0079). Ключи — под
 * `['object', id, …]`: realtime ядра (`object.updated` с полем `process`)
 * сбрасывает их вместе с карточкой.
 */
export const processKeys = {
  list: (objectId: string) => ['object', objectId, 'processes'] as const,
  instance: (objectId: string, instanceId: string) =>
    ['object', objectId, 'process', instanceId] as const,
}

export const objectProcessesQuery = (objectId: string) =>
  queryOptions({
    queryKey: processKeys.list(objectId),
    queryFn: async () =>
      (
        await http.get<{ items: ProcessInstanceSummary[] }>('/processes', {
          query: { objectId },
        })
      ).items,
  })

export const processQuery = (objectId: string, instanceId: string) =>
  queryOptions({
    queryKey: processKeys.instance(objectId, instanceId),
    queryFn: () => http.get<ProcessInstanceView>(`/processes/${instanceId}`),
  })

/** Решение шага: согласовать, замечания, отклонить, подписать… (код и файлы — по шагу). */
export interface StepActInput {
  action: string
  comment?: string
  code?: string
  fileIds?: string[]
}

/** Заместитель решает за замещаемого — запрос «от имени» (ADR-0079). */
const actingAs = (onBehalfOf: string | null | undefined) =>
  onBehalfOf ? { headers: { 'x-kchs-on-behalf-of': onBehalfOf } } : undefined

export const processApi = {
  act: (instanceId: string, stepId: string, input: StepActInput, onBehalfOf?: string | null) =>
    http.post(`/processes/${instanceId}/steps/${stepId}/act`, input, actingAs(onBehalfOf)),
  delegate: (
    instanceId: string,
    stepId: string,
    input: { userId: string; comment?: string },
    onBehalfOf?: string | null,
  ) => http.post(`/processes/${instanceId}/steps/${stepId}/delegate`, input, actingAs(onBehalfOf)),
  addAssignee: (
    instanceId: string,
    stepId: string,
    input: { userId: string; comment?: string },
    onBehalfOf?: string | null,
  ) => http.post(`/processes/${instanceId}/steps/${stepId}/assignees`, input, actingAs(onBehalfOf)),
  cancel: (instanceId: string, reason?: string) =>
    http.post(`/processes/${instanceId}/cancel`, reason ? { reason } : {}),
}

/** Ключи кэша определений маршрутов для конструктора (ADR-0079, ADR-0087). */
export const definitionKeys = {
  all: ['process-definitions'] as const,
  list: ['process-definitions', 'list'] as const,
  details: (key: string) => ['process-definitions', 'details', key] as const,
  catalog: ['process-definitions', 'catalog'] as const,
  principals: (keys: readonly string[]) => ['principals', 'describe', keys] as const,
}

export const processDefinitionsQuery = () =>
  queryOptions({
    queryKey: definitionKeys.list,
    queryFn: () => http.get<{ items: ProcessDefinitionSummary[] }>('/process-definitions'),
    select: (data: { items: ProcessDefinitionSummary[] }) => data.items,
  })

export const processDefinitionQuery = (key: string) =>
  queryOptions({
    queryKey: definitionKeys.details(key),
    queryFn: () => http.get<ProcessDefinitionDetails>(`/process-definitions/${key}`),
  })

export const processCatalogQuery = () =>
  queryOptions({
    queryKey: definitionKeys.catalog,
    queryFn: () => http.get<ProcessCatalog>('/process-catalog'),
    staleTime: 60_000,
  })

/** Названия людей, подразделений и групп выражений `user:<id>`… — по ключам. */
export const principalRefsQuery = (keys: readonly string[]) =>
  queryOptions({
    queryKey: definitionKeys.principals(keys),
    queryFn: () =>
      http.get<{ items: PrincipalRef[] }>('/principals/describe', {
        query: { keys: keys.join(',') },
      }),
    select: (data: { items: PrincipalRef[] }) =>
      new Map(data.items.map((item) => [`${item.type}:${item.id}`, item])),
    enabled: keys.length > 0,
    staleTime: 60_000,
  })
