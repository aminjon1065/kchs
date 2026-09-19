import type { TaskStatus } from '@kchs/contracts'
import { localDate } from '~/kernel/business-calendar/working-days.js'
import type { CalendarProjectionProvider } from '~/modules/calendar/public.js'
import { isClosed, isOverdue } from './task-rules.js'
import { TaskService } from './task-service.js'

/**
 * Сроки задач и поручений в календаре (12-calendar-notifications-home.md §1,
 * ADR-0081): виртуальные события на дату срока в поясе смотрящего. Срок «до
 * конца дня» — на весь день, иначе — со временем.
 */
export const taskDueProjection: CalendarProjectionProvider = {
  key: 'tasks.due',
  labelKey: 'calendar.projections.tasksDue',
  icon: 'task',
  list: async (ctx, range) => {
    const rows = await TaskService.dueBetween(ctx, range.from, range.to)
    return rows.flatMap((row) => {
      if (!row.dueAt) return []
      const due = new Date(row.dueAt)
      const status = row.status as TaskStatus
      // Последняя минута дня — срок «до конца дня»
      const endOfDay =
        localDate(new Date(due.getTime() + 60_000), range.timezone) !==
        localDate(due, range.timezone)
      return [
        {
          objectId: row.id,
          objectType: 'task' as const,
          title: row.title,
          subtitle: row.key,
          date: localDate(due, range.timezone),
          at: endOfDay ? null : row.dueAt,
          status,
          overdue: isOverdue(status, row.dueAt),
          done: isClosed(status),
        },
      ]
    })
  },
}
