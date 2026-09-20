import type {
  ManualRule,
  RuleCatalog,
  RuleCreateInput,
  RuleDefinition,
  RuleDryRunResult,
  RuleList,
  RuleListQuery,
  RuleRecord,
  RuleRunList,
  RuleTemplate,
  RuleValidateResult,
  ScheduleList,
  ScheduleRecord,
  ScheduleRunList,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/** Ключи кэша правил автоматизации и расписаний (ADR-0096). */
export const automationKeys = {
  all: ['automation'] as const,
  rules: (query: Partial<RuleListQuery> = {}) => ['automation', 'rules', query] as const,
  rule: (id: string) => ['automation', 'rule', id] as const,
  runs: (id: string) => ['automation', 'rule', id, 'runs'] as const,
  templates: ['automation', 'templates'] as const,
  catalog: ['automation', 'catalog'] as const,
  manual: (objectId: string) => ['object', objectId, 'manual-rules'] as const,
  schedules: ['automation', 'schedules'] as const,
  scheduleRuns: (key: string) => ['automation', 'schedules', key, 'runs'] as const,
}

export const rulesQuery = (query: Partial<RuleListQuery> = {}) =>
  queryOptions({
    queryKey: automationKeys.rules(query),
    queryFn: () => http.get<RuleList>('/automation/rules', { query }),
  })

export const ruleQuery = (id: string) =>
  queryOptions({
    queryKey: automationKeys.rule(id),
    queryFn: () => http.get<RuleRecord>(`/automation/rules/${id}`),
    enabled: id.length > 0,
  })

export const ruleRunsQuery = (id: string) =>
  queryOptions({
    queryKey: automationKeys.runs(id),
    queryFn: () => http.get<RuleRunList>(`/automation/rules/${id}/runs`, { query: { limit: 30 } }),
    enabled: id.length > 0,
    refetchInterval: 5000,
  })

export const ruleTemplatesQuery = () =>
  queryOptions({
    queryKey: automationKeys.templates,
    queryFn: () => http.get<{ items: RuleTemplate[] }>('/automation/templates'),
    select: (data: { items: RuleTemplate[] }) => data.items,
    staleTime: 300_000,
  })

export const ruleCatalogQuery = () =>
  queryOptions({
    queryKey: automationKeys.catalog,
    queryFn: () => http.get<RuleCatalog>('/automation/catalog'),
    staleTime: 300_000,
  })

/** Правила с кнопкой у объекта: меню «⋯» карточки. */
export const manualRulesQuery = (objectId: string) =>
  queryOptions({
    queryKey: automationKeys.manual(objectId),
    queryFn: () =>
      http.get<{ items: ManualRule[] }>('/automation/manual-rules', { query: { objectId } }),
    select: (data: { items: ManualRule[] }) => data.items,
    enabled: objectId.length > 0,
    staleTime: 60_000,
  })

export const schedulesQuery = () =>
  queryOptions({
    queryKey: automationKeys.schedules,
    queryFn: () => http.get<ScheduleList>('/schedules'),
    select: (data: ScheduleList) => data.items,
    refetchInterval: 30_000,
  })

export const scheduleRunsQuery = (key: string) =>
  queryOptions({
    queryKey: automationKeys.scheduleRuns(key),
    queryFn: () =>
      http.get<ScheduleRunList>(`/schedules/${encodeURIComponent(key)}/runs`, {
        query: { limit: 20 },
      }),
    select: (data: ScheduleRunList) => data.items,
    enabled: key.length > 0,
  })

export const automationApi = {
  create: (input: RuleCreateInput) => http.post<{ id: string }>('/automation/rules', input),
  update: (id: string, definition: RuleDefinition) =>
    http.put<RuleRecord>(`/automation/rules/${id}`, { definition }),
  setEnabled: (id: string, enabled: boolean) =>
    http.post<RuleRecord>(`/automation/rules/${id}/enabled`, { enabled }),
  validate: (definition: RuleDefinition) =>
    http.post<RuleValidateResult>('/automation/rules/validate', { definition }),
  dryRun: (definition: RuleDefinition, limit: number) =>
    http.post<RuleDryRunResult>('/automation/rules/dry-run', { definition, limit }),
  run: (id: string, objectId: string | null) =>
    http.post<{ runId: string }>(`/automation/rules/${id}/run`, { objectId }),
  scheduleEnabled: (key: string, enabled: boolean) =>
    http.post<ScheduleRecord>(`/schedules/${encodeURIComponent(key)}/enabled`, { enabled }),
  scheduleRun: (key: string) =>
    http.post<{ ok: boolean }>(`/schedules/${encodeURIComponent(key)}/run`),
}
