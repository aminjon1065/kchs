import { useQueryClient } from '@tanstack/react-query'
import { ApiError } from '~/shared/api/errors.js'
import { keys } from '~/shared/api/queries.js'
import { taskKeys } from './queries.js'

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
