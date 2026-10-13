import type { ControlListQuery, ControlQuery, TaskListQuery, WorkloadQuery } from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { ApiError, http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

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
  metrics: ['tasks', 'metrics'] as const,
  task: (id: string) => ['object', id, 'task'] as const,
  projects: (spaceId?: string) => ['projects', spaceId ?? 'all'] as const,
  project: (id: string) => ['object', id, 'project'] as const,
}

/** Логическое значение в строке запроса — `'true'` или `'false'`: так его читает `z.stringbool`. */
type QueryValue<V> = V extends boolean ? 'true' | 'false' : V

/**
 * Параметры экрана → строка запроса маршрута: логические значения — строками, остальное как
 * есть. Тип сохраняется — компилятор сверяет результат со схемой строки запроса; пустые
 * значения клиент API не отправляет.
 */
export function queryOf<T extends object>(query: T): { [K in keyof T]: QueryValue<T[K]> } {
  return Object.fromEntries(
    Object.entries(query).map(([key, value]) => [
      key,
      typeof value === 'boolean' ? String(value) : value,
    ]),
  ) as { [K in keyof T]: QueryValue<T[K]> }
}

export const tasksQuery = (query: Partial<TaskListQuery>) =>
  queryOptions({
    queryKey: taskKeys.list(query),
    queryFn: () => http.get('/tasks', { query: queryOf(query) }),
  })

export const taskSummaryQuery = () =>
  queryOptions({
    queryKey: taskKeys.summary,
    queryFn: () => http.get('/tasks/summary'),
    staleTime: 30_000,
  })

export const taskQuery = (id: string) =>
  queryOptions({
    queryKey: taskKeys.task(id),
    queryFn: () => http.get('/tasks/:id', { params: { id } }),
  })

/** Поручения и задачи по строке датасета — для карточки строки. */
export const rowTasksQuery = (datasetId: string, rowId: string) =>
  queryOptions({
    queryKey: taskKeys.byRow(datasetId, rowId),
    queryFn: () => http.get('/tasks/by-row', { query: { datasetId, rowId } }),
  })

/** Контроль исполнения: матрица, итоги, динамика (ADR-0082). */
export const controlQuery = (query: Partial<ControlQuery>) =>
  queryOptions({
    queryKey: taskKeys.control(query),
    queryFn: () => http.get('/tasks/control', { query: queryOf(query) }),
  })

/** Поручения ячейки матрицы контроля. */
export const controlListQuery = (query: Partial<ControlListQuery>) =>
  queryOptions({
    queryKey: taskKeys.controlList(query),
    queryFn: () => http.get('/tasks/control/list', { query: queryOf(query) }),
  })

export const workloadQuery = (query: Partial<WorkloadQuery>) =>
  queryOptions({
    queryKey: taskKeys.workload(query),
    queryFn: () => http.get('/tasks/workload', { query: queryOf(query) }),
  })

export const issuedQuery = () =>
  queryOptions({
    queryKey: taskKeys.issued,
    queryFn: () => http.get('/tasks/issued'),
    staleTime: 30_000,
  })

export const teamQuery = () =>
  queryOptions({
    queryKey: taskKeys.team,
    queryFn: () => http.get('/tasks/team'),
    staleTime: 30_000,
  })

export const taskSettingsQuery = () =>
  queryOptions({
    queryKey: taskKeys.settings,
    queryFn: () => http.get('/tasks/settings'),
  })

/** Показатели контроля на установке — консоль, раздел «Поручения». */
export const controlMetricsQuery = () =>
  queryOptions({
    queryKey: taskKeys.metrics,
    queryFn: () => http.get('/admin/tasks/metrics'),
  })

export const projectsQuery = (spaceId?: string) =>
  queryOptions({
    queryKey: taskKeys.projects(spaceId),
    queryFn: async () =>
      (await http.get('/projects', { ...(spaceId ? { query: { spaceId } } : {}) })).items,
  })

export const projectQuery = (id: string) =>
  queryOptions({
    queryKey: taskKeys.project(id),
    queryFn: () => http.get('/projects/:id', { params: { id } }),
  })

// ─── Действия по задаче (10-tasks-projects.md §4, ADR-0082) ─────────────────

export const reportTask = (id: string, body: ApiBody<'POST /tasks/:id/report'>) =>
  http.post('/tasks/:id/report', { params: { id }, body })

export const returnTask = (id: string, body: ApiBody<'POST /tasks/:id/return'>) =>
  http.post('/tasks/:id/return', { params: { id }, body })

export const requestExtension = (id: string, body: ApiBody<'POST /tasks/:id/extension'>) =>
  http.post('/tasks/:id/extension', { params: { id }, body })

export const decideExtension = (id: string, body: ApiBody<'POST /tasks/:id/extension/decide'>) =>
  http.post('/tasks/:id/extension/decide', { params: { id }, body })

export const reassignTask = (id: string, body: ApiBody<'POST /tasks/:id/reassign'>) =>
  http.post('/tasks/:id/reassign', { params: { id }, body })

/** Ошибки полей из ответа сервера — подсветка формы; иной сбой — без полей. */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  return error instanceof ApiError ? error.fieldErrors() : {}
}
