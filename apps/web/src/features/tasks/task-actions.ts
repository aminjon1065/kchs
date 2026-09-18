import type { TaskRecord, TaskStatus } from '@kchs/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, http } from '~/shared/api/client.js'
import { keys } from '~/shared/api/queries.js'
import { taskKeys } from './queries.js'

/** Шаг без формы: статус задачи или действие поручения без текста. */
export type TaskStep =
  | { kind: 'status'; status: TaskStatus }
  | { kind: 'start' }
  | { kind: 'accept' }
  | { kind: 'cancel' }

export function postTaskStep(taskId: string, step: TaskStep): Promise<TaskRecord> {
  if (step.kind === 'status') {
    return http.post<TaskRecord>(`/tasks/${taskId}/status`, { status: step.status })
  }
  if (step.kind === 'cancel') return http.post<TaskRecord>(`/tasks/${taskId}/cancel`, {})
  return http.post<TaskRecord>(`/tasks/${taskId}/${step.kind}`)
}

export function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

/**
 * После действия над задачей: списки, сводка, задачи строки, карточка,
 * счётчики проектов и Входящие (действие закрывает или открывает дела).
 */
export function useTaskInvalidation(): (taskId?: string) => void {
  const client = useQueryClient()
  return (taskId) => {
    void client.invalidateQueries({ queryKey: taskKeys.all })
    void client.invalidateQueries({ queryKey: ['projects'] })
    void client.invalidateQueries({
      predicate: (query) => query.queryKey[0] === 'object' && query.queryKey[2] === 'project',
    })
    void client.invalidateQueries({ queryKey: ['inbox'] })
    void client.invalidateQueries({ queryKey: keys.inboxCounts })
    if (taskId) void client.invalidateQueries({ queryKey: taskKeys.task(taskId) })
  }
}
