import type { RuleCreateInput, RuleDefinition, RuleExport, RuleListQuery } from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/** Ключи кэша правил автоматизации и расписаний (ADR-0096). */
export const automationKeys = {
  all: ['automation'] as const,
  rules: (query: Partial<RuleListQuery> = {}) => ['automation', 'rules', query] as const,
  rule: (id: string) => ['automation', 'rule', id] as const,
  runs: (id: string) => ['automation', 'rule', id, 'runs'] as const,
  versions: (id: string) => ['automation', 'rule', id, 'versions'] as const,
  templates: ['automation', 'templates'] as const,
  catalog: ['automation', 'catalog'] as const,
  manual: (objectId: string) => ['object', objectId, 'manual-rules'] as const,
  schedules: ['automation', 'schedules'] as const,
  scheduleRuns: (key: string) => ['automation', 'schedules', key, 'runs'] as const,
}

export const rulesQuery = (query: Partial<RuleListQuery> = {}) =>
  queryOptions({
    queryKey: automationKeys.rules(query),
    queryFn: () => http.get('/automation/rules', { query }),
  })

export const ruleQuery = (id: string) =>
  queryOptions({
    queryKey: automationKeys.rule(id),
    queryFn: () => http.get('/automation/rules/:id', { params: { id } }),
    enabled: id.length > 0,
  })

export const ruleRunsQuery = (id: string) =>
  queryOptions({
    queryKey: automationKeys.runs(id),
    queryFn: () => http.get('/automation/rules/:id/runs', { params: { id }, query: { limit: 30 } }),
    enabled: id.length > 0,
    refetchInterval: 5000,
  })

/** Версии определения правила (ADR-0163). */
export const ruleVersionsQuery = (id: string) =>
  queryOptions({
    queryKey: automationKeys.versions(id),
    queryFn: () => http.get('/automation/rules/:id/versions', { params: { id } }),
    select: (data) => data.items,
    enabled: id.length > 0,
  })

export const ruleTemplatesQuery = () =>
  queryOptions({
    queryKey: automationKeys.templates,
    queryFn: () => http.get('/automation/templates'),
    select: (data) => data.items,
    staleTime: 300_000,
  })

export const ruleCatalogQuery = () =>
  queryOptions({
    queryKey: automationKeys.catalog,
    queryFn: () => http.get('/automation/catalog'),
    staleTime: 300_000,
  })

/** Правила с кнопкой у объекта: меню «⋯» карточки. */
export const manualRulesQuery = (objectId: string) =>
  queryOptions({
    queryKey: automationKeys.manual(objectId),
    queryFn: () => http.get('/automation/manual-rules', { query: { objectId } }),
    select: (data) => data.items,
    enabled: objectId.length > 0,
    staleTime: 60_000,
  })

export const schedulesQuery = () =>
  queryOptions({
    queryKey: automationKeys.schedules,
    queryFn: () => http.get('/schedules'),
    select: (data) => data.items,
    refetchInterval: 30_000,
  })

export const scheduleRunsQuery = (key: string) =>
  queryOptions({
    queryKey: automationKeys.scheduleRuns(key),
    queryFn: () => http.get('/schedules/:key/runs', { params: { key }, query: { limit: 20 } }),
    select: (data) => data.items,
    enabled: key.length > 0,
  })

export const automationApi = {
  create: (input: RuleCreateInput) => http.post('/automation/rules', { body: input }),
  update: (id: string, definition: RuleDefinition) =>
    http.put('/automation/rules/:id', { params: { id }, body: { definition } }),
  setEnabled: (id: string, enabled: boolean) =>
    http.post('/automation/rules/:id/enabled', { params: { id }, body: { enabled } }),
  validate: (definition: RuleDefinition) =>
    http.post('/automation/rules/validate', { body: { definition } }),
  dryRun: (definition: RuleDefinition, limit: number) =>
    http.post('/automation/rules/dry-run', { body: { definition, limit } }),
  duplicate: (id: string) => http.post('/automation/rules/:id/duplicate', { params: { id } }),
  restore: (id: string, versionId: string) =>
    http.post('/automation/rules/:id/versions/:versionId/restore', { params: { id, versionId } }),
  exportRule: (id: string) => http.get('/automation/rules/:id/export', { params: { id } }),
  importRule: (spaceId: string, rule: RuleExport) =>
    http.post('/automation/rules/import', { body: { spaceId, rule } }),
  run: (id: string, objectId: string | null) =>
    http.post('/automation/rules/:id/run', { params: { id }, body: { objectId } }),
  scheduleEnabled: (key: string, enabled: boolean) =>
    http.post('/schedules/:key/enabled', { params: { key }, body: { enabled } }),
  scheduleRun: (key: string) => http.post('/schedules/:key/run', { params: { key } }),
}
