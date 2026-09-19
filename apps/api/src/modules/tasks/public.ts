/**
 * Публичный API модуля «Задачи» для других модулей (01-overview.md §Как модули
 * взаимодействуют): сводка задач и поручений по территориям — паспорт
 * территории (ADR-0077). Видимость — предикат ядра для смотрящего.
 */
import type { Ctx } from '~/shared/context.js'
import { TaskService } from './domain/task-service.js'

export const TaskQueries = {
  /** Открытые, просроченные и закрытые задачи с территорией из списка. */
  territoryCounts: (
    ctx: Ctx,
    territoryIds: string[],
  ): Promise<{ open: number; overdue: number; closed: number }> =>
    TaskService.territoryCounts(ctx, territoryIds),
}
