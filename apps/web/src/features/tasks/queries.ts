import type {
  ControlList,
  ControlListQuery,
  ControlQuery,
  ControlReport,
  IssuedSummary,
  ProjectRecord,
  TaskList,
  TaskListQuery,
  TaskRecord,
  TaskSettings,
  TaskSummary,
  TeamSummary,
  WorkloadQuery,
  WorkloadReport,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/**
 * Ключи кэша задач. Карточка — под `['object', id, …]`: realtime ядра
 * инвалидирует `['object', id]` при любом изменении объекта.
 */
export const taskKeys = {
  all: ['tasks'] as const,
  list: (query: Partial<TaskListQuery>) => ['tasks', 'list', query] as const,
  summary: ['tasks', 'summary'] as const,
  byRow: (datasetId: string, rowId: string) => ['tasks', 'row', datasetId, rowId] as const,
  control: (query: Partial<ControlQuery>) => ['tasks', 'control', query] as const,
  controlList: (query: Partial<ControlListQuery>) => ['tasks', 'control-list', query] as const,
  workload: (query: Partial<WorkloadQuery>) => ['tasks', 'workload', query] as const,
  issued: ['tasks', 'issued'] as const,
  team: ['tasks', 'team'] as const,
  settings: ['tasks', 'settings'] as const,
  task: (id: string) => ['object', id, 'task'] as const,
  projects: (spaceId?: string) => ['projects', spaceId ?? 'all'] as const,
  project: (id: string) => ['object', id, 'project'] as const,
}

/** Параметры запроса без пустых значений. */
export function queryOf(query: object): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '' && value !== null) {
      result[key] = value as string | number | boolean
    }
  }
  return result
}

export const tasksQuery = (query: Partial<TaskListQuery>) =>
  queryOptions({
    queryKey: taskKeys.list(query),
    queryFn: () => http.get<TaskList>('/tasks', { query: queryOf(query) }),
  })

export const taskSummaryQuery = () =>
  queryOptions({
    queryKey: taskKeys.summary,
    queryFn: () => http.get<TaskSummary>('/tasks/summary'),
    staleTime: 30_000,
  })

export const taskQuery = (id: string) =>
  queryOptions({
    queryKey: taskKeys.task(id),
    queryFn: () => http.get<TaskRecord>(`/tasks/${id}`),
  })

/** Поручения и задачи по строке датасета — для карточки строки. */
export const rowTasksQuery = (datasetId: string, rowId: string) =>
  queryOptions({
    queryKey: taskKeys.byRow(datasetId, rowId),
    queryFn: () => http.get<TaskList>('/tasks/by-row', { query: { datasetId, rowId } }),
  })

/** Контроль исполнения: матрица, итоги, динамика (ADR-0082). */
export const controlQuery = (query: Partial<ControlQuery>) =>
  queryOptions({
    queryKey: taskKeys.control(query),
    queryFn: () => http.get<ControlReport>('/tasks/control', { query: queryOf(query) }),
  })

/** Поручения ячейки матрицы контроля. */
export const controlListQuery = (query: Partial<ControlListQuery>) =>
  queryOptions({
    queryKey: taskKeys.controlList(query),
    queryFn: () => http.get<ControlList>('/tasks/control/list', { query: queryOf(query) }),
  })

export const workloadQuery = (query: Partial<WorkloadQuery>) =>
  queryOptions({
    queryKey: taskKeys.workload(query),
    queryFn: () => http.get<WorkloadReport>('/tasks/workload', { query: queryOf(query) }),
  })

export const issuedQuery = () =>
  queryOptions({
    queryKey: taskKeys.issued,
    queryFn: () => http.get<IssuedSummary>('/tasks/issued'),
    staleTime: 30_000,
  })

export const teamQuery = () =>
  queryOptions({
    queryKey: taskKeys.team,
    queryFn: () => http.get<TeamSummary>('/tasks/team'),
    staleTime: 30_000,
  })

export const taskSettingsQuery = () =>
  queryOptions({
    queryKey: taskKeys.settings,
    queryFn: () => http.get<TaskSettings>('/tasks/settings'),
  })

export const projectsQuery = (spaceId?: string) =>
  queryOptions({
    queryKey: taskKeys.projects(spaceId),
    queryFn: async () =>
      (
        await http.get<{ items: ProjectRecord[] }>(
          '/projects',
          spaceId ? { query: { spaceId } } : {},
        )
      ).items,
  })

export const projectQuery = (id: string) =>
  queryOptions({
    queryKey: taskKeys.project(id),
    queryFn: () => http.get<ProjectRecord>(`/projects/${id}`),
  })
