import type { PrincipalRef } from '@kchs/contracts'
import type {
  ProcessCatalog,
  ProcessDefinitionDetails,
  ProcessDefinitionSummary,
} from '@kchs/process'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/** Ключи кэша маршрутов процессов (ADR-0079, ADR-0087). */
export const processKeys = {
  all: ['process-definitions'] as const,
  list: ['process-definitions', 'list'] as const,
  details: (key: string) => ['process-definitions', 'details', key] as const,
  catalog: ['process-definitions', 'catalog'] as const,
  principals: (keys: readonly string[]) => ['principals', 'describe', keys] as const,
}

export const processDefinitionsQuery = () =>
  queryOptions({
    queryKey: processKeys.list,
    queryFn: () => http.get<{ items: ProcessDefinitionSummary[] }>('/process-definitions'),
    select: (data: { items: ProcessDefinitionSummary[] }) => data.items,
  })

export const processDefinitionQuery = (key: string) =>
  queryOptions({
    queryKey: processKeys.details(key),
    queryFn: () => http.get<ProcessDefinitionDetails>(`/process-definitions/${key}`),
  })

export const processCatalogQuery = () =>
  queryOptions({
    queryKey: processKeys.catalog,
    queryFn: () => http.get<ProcessCatalog>('/process-catalog'),
    staleTime: 60_000,
  })

/** Названия людей, подразделений и групп выражений `user:<id>`… — по ключам. */
export const principalRefsQuery = (keys: readonly string[]) =>
  queryOptions({
    queryKey: processKeys.principals(keys),
    queryFn: () =>
      http.get<{ items: PrincipalRef[] }>('/principals/describe', {
        query: { keys: keys.join(',') },
      }),
    select: (data: { items: PrincipalRef[] }) =>
      new Map(data.items.map((item) => [`${item.type}:${item.id}`, item])),
    enabled: keys.length > 0,
    staleTime: 60_000,
  })
