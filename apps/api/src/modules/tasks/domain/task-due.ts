import type { TaskDueChange, TaskDueReason, UserRef } from '@kchs/contracts'
import { and, asc, eq, notInArray, sql } from 'drizzle-orm'
import { BusinessCalendar } from '~/kernel/business-calendar/service.js'
import { endOfLocalDay } from '~/kernel/business-calendar/working-days.js'
import { InboxService } from '~/kernel/inbox/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { actorId, type Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, taskDueChanges, tasks } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { CLOSED, emit, refsOf, type TaskView } from './task-core.js'

/** Срок из ввода: дата или «N рабочих дней» от момента `from`. */
export interface DueInput {
  dueAt?: string | null | undefined
  dueWorkingDays?: number | undefined
}

export interface ResolvedDue {
  dueAt: string | null
  /** Срок задан рабочими днями — сколько их было. */
  workingDays: number | null
}

/**
 * Срок поручения (10-tasks-projects.md §4, ADR-0082): «N рабочих дней» — конец
 * N-го рабочего дня после сегодняшнего по производственному календарю в поясе
 * установки (праздники и переносы пропускаются); дата — как передана.
 * `undefined` — срок не задан вводом.
 */
export async function resolveDue(
  input: DueInput,
  from: Date = new Date(),
  executor?: Executor,
): Promise<ResolvedDue | undefined> {
  if (input.dueWorkingDays !== undefined) {
    const { dueAt } = await BusinessCalendar.deadline(from, input.dueWorkingDays, {
      ...(executor ? { executor } : {}),
    })
    return { dueAt: dueAt.toISOString(), workingDays: input.dueWorkingDays }
  }
  if (input.dueAt === undefined) return undefined
  return { dueAt: input.dueAt, workingDays: null }
}

/** Дата `ГГГГ-ММ-ДД` из Входящих или Telegram — конец этого дня по часам пользователя. */
export function dueFromDate(date: unknown, timezone: string): string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw errors.validation('Укажите дату в виде ГГГГ-ММ-ДД', [
      { path: 'dueDate', message: 'Нужна дата' },
    ])
  }
  return endOfLocalDay(date, timezone).toISOString()
}

const sameMoment = (a: string | null, b: string | null): boolean =>
  a === b || (a !== null && b !== null && new Date(a).getTime() === new Date(b).getTime())

export { sameMoment }

/** Запись истории сроков: кто, когда, с какого на какой и почему. */
export async function recordDueChange(
  tx: Executor,
  ctx: Ctx,
  change: {
    taskId: string
    from: string | null
    to: string | null
    workingDays: number | null
    reason: TaskDueReason
    comment?: string | null
    extensionId?: string | null
  },
): Promise<void> {
  await tx.insert(taskDueChanges).values({
    taskId: change.taskId,
    fromDue: change.from,
    toDue: change.to,
    workingDays: change.workingDays,
    reason: change.reason,
    comment: change.comment?.trim() || null,
    actorId: actorId(ctx),
    onBehalfOf: ctx.kind === 'user' ? ctx.onBehalfOf : null,
    extensionId: change.extensionId ?? null,
  })
}

/**
 * Новый срок задачи в её транзакции: строка задачи, реестр, история, событие
 * `task.due_changed`, сроки открытых дел во Входящих и открытые части
 * соисполнителей, чей срок совпадал со сроком основного поручения.
 */
export async function applyDue(
  tx: Executor,
  ctx: Ctx,
  task: TaskView & { key: string; dueAt: string | null },
  next: ResolvedDue,
  change: { reason: TaskDueReason; comment?: string | null; extensionId?: string | null },
  extra: { extensions?: boolean } = {},
): Promise<boolean> {
  if (sameMoment(task.dueAt, next.dueAt)) return false
  await tx
    .update(tasks)
    .set({
      dueAt: next.dueAt,
      dueWorkingDays: next.workingDays,
      dueSetAt: sql`now()`,
      ...(extra.extensions ? { extensions: sql`${tasks.extensions} + 1` } : {}),
    })
    .where(eq(tasks.id, task.id))
  await ObjectService.update(
    tx,
    ctx,
    task.id,
    { meta: { dueAt: next.dueAt }, mergeMeta: true },
    { silent: true },
  )
  await recordDueChange(tx, ctx, {
    taskId: task.id,
    from: task.dueAt,
    to: next.dueAt,
    workingDays: next.workingDays,
    ...change,
  })
  await emit(tx, ctx, task, 'task.due_changed', { key: task.key, from: task.dueAt, to: next.dueAt })
  await InboxService.setDue(tx, { objectId: task.id }, next.dueAt)
  await followParent(tx, ctx, task, next)
  return true
}

/** Части соисполнителей идут за сроком основного поручения, если их срок не меняли отдельно. */
async function followParent(
  tx: Executor,
  ctx: Ctx,
  parent: { id: string; dueAt: string | null },
  next: ResolvedDue,
): Promise<void> {
  const parts = await tx
    .select({
      id: tasks.id,
      key: tasks.key,
      dueAt: tasks.dueAt,
      title: objects.title,
      spaceId: objects.spaceId,
    })
    .from(tasks)
    .innerJoin(objects, eq(objects.id, tasks.id))
    .where(
      and(
        eq(tasks.parentId, parent.id),
        notInArray(tasks.status, CLOSED),
        sql`${objects.deletedAt} IS NULL`,
      ),
    )
  for (const part of parts) {
    if (!sameMoment(part.dueAt, parent.dueAt)) continue
    await applyDue(tx, ctx, part, next, { reason: 'parent' })
  }
}

/** История сроков задачи — для карточки. */
export async function dueHistoryOf(taskId: string): Promise<TaskDueChange[]> {
  const rows = await db()
    .select()
    .from(taskDueChanges)
    .where(eq(taskDueChanges.taskId, taskId))
    .orderBy(asc(taskDueChanges.id))
  const people = await refsOf(rows.flatMap((row) => [row.actorId, row.onBehalfOf]))
  const ref = (id: string | null): UserRef | null => (id ? (people.get(id) ?? null) : null)
  return rows.map((row) => ({
    id: String(row.id),
    from: row.fromDue,
    to: row.toDue,
    workingDays: row.workingDays,
    reason: row.reason as TaskDueReason,
    comment: row.comment,
    actor: ref(row.actorId),
    onBehalfOf: ref(row.onBehalfOf),
    at: row.createdAt,
  }))
}
