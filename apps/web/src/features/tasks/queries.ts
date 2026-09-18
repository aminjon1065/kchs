import type {
  ProjectRecord,
  TaskList,
  TaskListQuery,
  TaskRecord,
  TaskSummary,
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
  task: (id: string) => ['object', id, 'task'] as const,
  projects: (spaceId?: string) => ['projects', spaceId ?? 'all'] as const,
  project: (id: string) => ['object', id, 'project'] as const,
}

/** Параметры запроса без пустых значений. */
function queryOf(query: Partial<TaskListQuery>): Record<string, string | number> {
  const result: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') result[key] = value as string | number
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
