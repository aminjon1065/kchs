import { nextRuns } from '~/kernel/schedules/index.js'
import type { objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'

/** Общее у источников внешней базы (ADR-0107) и лент по адресу (ADR-0132). */

export type SourceObjectRow = Pick<typeof objects.$inferSelect, 'title' | 'spaceId' | 'parentId'>

export function assertCron(pattern: string | null | undefined): void {
  if (!pattern) return
  try {
    nextRuns(pattern, 'UTC', 1)
  } catch {
    throw errors.validation('Не удалось разобрать расписание: нужно выражение cron из пяти полей')
  }
}

/** Объект события источника. */
export const sourceEventObject = (id: string, object: SourceObjectRow) => ({
  id,
  type: 'source' as const,
  spaceId: object.spaceId,
  title: object.title,
})
