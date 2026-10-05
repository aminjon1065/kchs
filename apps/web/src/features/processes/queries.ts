import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

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
    queryFn: async () => (await http.get('/processes', { query: { objectId } })).items,
  })

export const processQuery = (objectId: string, instanceId: string) =>
  queryOptions({
    queryKey: processKeys.instance(objectId, instanceId),
    queryFn: () => http.get('/processes/:id', { params: { id: instanceId } }),
  })

/** Заместитель решает за замещаемого — запрос «от имени» (ADR-0079). */
const actingAs = (onBehalfOf: string | null | undefined) =>
  onBehalfOf ? { headers: { 'x-kchs-on-behalf-of': onBehalfOf } } : undefined

export const processApi = {
  /** Решение шага: согласовать, замечания, отклонить, подписать… (код и файлы — по шагу). */
  act: (
    instanceId: string,
    stepId: string,
    input: ApiBody<'POST /processes/:id/steps/:stepId/act'>,
    onBehalfOf?: string | null,
  ) =>
    http.post('/processes/:id/steps/:stepId/act', {
      params: { id: instanceId, stepId },
      body: input,
      ...actingAs(onBehalfOf),
    }),
  delegate: (
    instanceId: string,
    stepId: string,
    input: { userId: string; comment?: string },
    onBehalfOf?: string | null,
  ) =>
    http.post('/processes/:id/steps/:stepId/delegate', {
      params: { id: instanceId, stepId },
      body: input,
      ...actingAs(onBehalfOf),
    }),
  addAssignee: (
    instanceId: string,
    stepId: string,
    input: { userId: string; comment?: string },
    onBehalfOf?: string | null,
  ) =>
    http.post('/processes/:id/steps/:stepId/assignees', {
      params: { id: instanceId, stepId },
      body: input,
      ...actingAs(onBehalfOf),
    }),
  cancel: (instanceId: string, reason?: string) =>
    http.post('/processes/:id/cancel', {
      params: { id: instanceId },
      body: reason ? { reason } : {},
    }),
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
    queryFn: () => http.get('/process-definitions'),
    select: (data) => data.items,
  })

export const processDefinitionQuery = (key: string) =>
  queryOptions({
    queryKey: definitionKeys.details(key),
    queryFn: () => http.get('/process-definitions/:key', { params: { key } }),
  })

export const processCatalogQuery = () =>
  queryOptions({
    queryKey: definitionKeys.catalog,
    queryFn: () => http.get('/process-catalog'),
    staleTime: 60_000,
  })

/** Названия людей, подразделений и групп выражений `user:<id>`… — по ключам. */
export const principalRefsQuery = (keys: readonly string[]) =>
  queryOptions({
    queryKey: definitionKeys.principals(keys),
    queryFn: () => http.get('/principals/describe', { query: { keys: keys.join(',') } }),
    select: (data) => new Map(data.items.map((item) => [`${item.type}:${item.id}`, item])),
    enabled: keys.length > 0,
    staleTime: 60_000,
  })
