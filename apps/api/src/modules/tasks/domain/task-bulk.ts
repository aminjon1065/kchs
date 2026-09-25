import type { TaskBulkAction, TaskBulkInput, TaskBulkResult } from '@kchs/contracts'
import { inArray } from 'drizzle-orm'
import type { UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { tasks } from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import { loadRow } from './task-core.js'
import { TaskService } from './task-service.js'

/** Одно действие над одной задачей — теми же операциями, что и из карточки. */
async function applyOne(
  tx: Executor,
  ctx: UserCtx,
  id: string,
  action: TaskBulkAction,
): Promise<void> {
  const row = await loadRow(tx, id)
  if (!row) throw errors.notFound('Задача')
  const instruction = row.kind === 'instruction'
  switch (action.kind) {
    case 'reassign':
      if (instruction) {
        await TaskService.reassign(tx, ctx, id, {
          assigneeId: action.assigneeId,
          ...(action.comment ? { comment: action.comment } : {}),
        })
      } else {
        await TaskService.update(tx, ctx, id, { assigneeId: action.assigneeId })
      }
      return
    case 'due':
      await TaskService.update(tx, ctx, id, {
        ...(action.dueAt !== undefined ? { dueAt: action.dueAt } : {}),
        ...(action.dueWorkingDays !== undefined ? { dueWorkingDays: action.dueWorkingDays } : {}),
        ...(action.comment ? { dueComment: action.comment } : {}),
      })
      return
    case 'close':
      if (instruction) await TaskService.accept(tx, ctx, id)
      else await TaskService.setStatus(tx, ctx, id, 'done')
      return
    case 'cancel':
      await TaskService.cancel(tx, ctx, id, action.comment ? { comment: action.comment } : {})
      return
    case 'project':
      await TaskService.moveToProject(tx, ctx, id, action.projectId)
      return
  }
}

/**
 * Массовые действия списка задач (ADR-0155): каждая задача — своя транзакция и своя
 * проверка прав; отказ по одной не откатывает остальные. Ошибки проверки и прав
 * становятся причинами пропуска, сбои сервера — ошибкой запроса.
 */
export async function applyBulk(ctx: UserCtx, input: TaskBulkInput): Promise<TaskBulkResult> {
  const ids = [...new Set(input.ids)]
  let done = 0
  const failed: Array<{ id: string; reason: string }> = []
  for (const id of ids) {
    try {
      await db().transaction((tx) => applyOne(tx, ctx, id, input.action))
      done += 1
    } catch (error) {
      if (error instanceof AppError && error.status < 500) {
        failed.push({ id, reason: error.message })
        continue
      }
      throw error
    }
  }
  const keys = failed.length
    ? new Map(
        (
          await db()
            .select({ id: tasks.id, key: tasks.key })
            .from(tasks)
            .where(
              inArray(
                tasks.id,
                failed.map((item) => item.id),
              ),
            )
        ).map((row) => [row.id, row.key]),
      )
    : new Map<string, string>()
  return {
    done,
    skipped: failed.map((item) => ({ ...item, key: keys.get(item.id) ?? null })),
  }
}
