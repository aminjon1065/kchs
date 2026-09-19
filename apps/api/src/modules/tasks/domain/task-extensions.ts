import type {
  TaskExtension,
  TaskExtensionDecisionInput,
  TaskExtensionRequestInput,
  TaskExtensionStatus,
} from '@kchs/contracts'
import { and, desc, eq, sql } from 'drizzle-orm'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import type { Ctx } from '~/shared/context.js'
import { actorId } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { pgErrorCode, UNIQUE_VIOLATION } from '~/shared/db/pg-error.js'
import { taskExtensions } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { emit, refsOf, type TaskRow, viewOf } from './task-core.js'
import { applyDue, type ResolvedDue, resolveDue } from './task-due.js'
import { TaskInbox } from './task-inbox.js'
import { extensionDecider } from './task-rules.js'

type ExtensionRow = typeof taskExtensions.$inferSelect

/**
 * Продление срока поручения (10-tasks-projects.md §4, 08-documents.md §6,
 * ADR-0082): исполнитель просит с обоснованием и желаемым сроком → дело
 * «рассмотреть продление» во Входящих автора → согласовать (запрошенный или
 * другой срок) или отказать. Всё — с аудитом и в истории сроков; согласованное
 * продление ставит отметку «продлено» для контроля.
 */
export const TaskExtensions = {
  async request(
    tx: Executor,
    ctx: Ctx,
    row: TaskRow,
    input: TaskExtensionRequestInput,
  ): Promise<string> {
    const requested = (await resolveDue(input, new Date(), tx)) as ResolvedDue
    if (!requested.dueAt) throw errors.validation('Укажите желаемый срок')
    if (row.dueAt && new Date(requested.dueAt).getTime() <= new Date(row.dueAt).getTime()) {
      throw errors.validation('Новый срок должен быть позже текущего', [
        { path: 'dueAt', message: 'Новый срок должен быть позже текущего' },
      ])
    }
    const decider = extensionDecider(row)
    if (!decider) throw errors.conflict('Некому рассмотреть продление: у поручения нет автора')
    const id = newId()
    try {
      await tx.insert(taskExtensions).values({
        id,
        taskId: row.id,
        status: 'pending',
        fromDue: row.dueAt,
        requestedDue: requested.dueAt,
        requestedWorkingDays: requested.workingDays,
        reason: input.reason.trim(),
        requestedBy: actorId(ctx),
        requestedOnBehalfOf: ctx.kind === 'user' ? ctx.onBehalfOf : null,
      })
    } catch (error) {
      if (pgErrorCode(error) === UNIQUE_VIOLATION) {
        throw errors.conflict('Запрос продления уже ждёт решения автора')
      }
      throw error
    }
    await emit(tx, ctx, viewOf(row), 'task.extension_requested', {
      key: row.key,
      extensionId: id,
      from: row.dueAt,
      to: requested.dueAt,
      reason: input.reason.trim(),
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.taskExtensionRequested,
        objectId: row.id,
        objectType: 'task',
        details: { key: row.key, from: row.dueAt, to: requested.dueAt, extensionId: id },
      },
      tx,
    )
    await TaskInbox.extensionRequested(
      tx,
      ctx,
      {
        id: row.id,
        authorId: row.authorId,
        assigneeId: row.assigneeId,
        controllerId: row.controllerId,
        dueAt: row.dueAt,
        priority: row.priority,
      },
      decider,
      { extensionId: id, requestedDueAt: requested.dueAt, reason: input.reason.trim() },
    )
    return id
  },

  async decide(
    tx: Executor,
    ctx: Ctx,
    row: TaskRow,
    input: TaskExtensionDecisionInput,
  ): Promise<void> {
    const pending = await pendingOf(tx, row.id, true)
    if (!pending) throw errors.conflict('Запроса продления, ждущего решения, нет')
    const decidedBy = actorId(ctx)
    const onBehalfOf = ctx.kind === 'user' ? ctx.onBehalfOf : null
    const comment = input.comment?.trim() || null

    if (input.decision === 'reject') {
      await tx
        .update(taskExtensions)
        .set({
          status: 'rejected',
          decidedBy,
          decidedOnBehalfOf: onBehalfOf,
          decidedAt: sql`now()`,
          decisionComment: comment,
        })
        .where(eq(taskExtensions.id, pending.id))
      await emit(tx, ctx, viewOf(row), 'task.extension_decided', {
        key: row.key,
        extensionId: pending.id,
        decision: 'rejected',
        from: row.dueAt,
        to: null,
      })
      await audit(
        ctx,
        {
          action: AUDIT_ACTIONS.taskExtensionDecided,
          objectId: row.id,
          objectType: 'task',
          details: { key: row.key, decision: 'rejected', extensionId: pending.id, comment },
        },
        tx,
      )
      await TaskInbox.close(tx, ctx, row.id, { kind: 'extend_due' })
      return
    }

    // Согласовать: запрошенный срок или другой, назначенный автором
    const other = await resolveDue(input, new Date(), tx)
    const next: ResolvedDue = other ?? {
      dueAt: pending.requestedDue,
      workingDays: pending.requestedWorkingDays,
    }
    if (!next.dueAt) throw errors.validation('Укажите новый срок')
    await tx
      .update(taskExtensions)
      .set({
        status: 'approved',
        decidedBy,
        decidedOnBehalfOf: onBehalfOf,
        decidedAt: sql`now()`,
        decisionComment: comment,
        approvedDue: next.dueAt,
      })
      .where(eq(taskExtensions.id, pending.id))
    await applyDue(
      tx,
      ctx,
      { ...viewOf(row), key: row.key, dueAt: row.dueAt },
      next,
      { reason: 'extension', comment: comment ?? pending.reason, extensionId: pending.id },
      { extensions: true },
    )
    await emit(tx, ctx, viewOf(row), 'task.extension_decided', {
      key: row.key,
      extensionId: pending.id,
      decision: 'approved',
      from: row.dueAt,
      to: next.dueAt,
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.taskExtensionDecided,
        objectId: row.id,
        objectType: 'task',
        details: {
          key: row.key,
          decision: 'approved',
          extensionId: pending.id,
          from: row.dueAt,
          to: next.dueAt,
          comment,
        },
      },
      tx,
    )
    await TaskInbox.close(tx, ctx, row.id, { kind: 'extend_due' })
  },

  /** Поручение закрыто, отменено или переназначено — запрос продления снимается. */
  async cancelPending(tx: Executor, ctx: Ctx, taskId: string): Promise<void> {
    const cancelled = await tx
      .update(taskExtensions)
      .set({ status: 'cancelled', decidedAt: sql`now()` })
      .where(and(eq(taskExtensions.taskId, taskId), eq(taskExtensions.status, 'pending')))
      .returning({ id: taskExtensions.id })
    if (cancelled.length > 0) {
      await TaskInbox.close(tx, ctx, taskId, { kind: 'extend_due' }, 'dismissed')
    }
  },

  /** Последний запрос продления — для карточки. */
  async latest(taskId: string): Promise<TaskExtension | null> {
    const [row] = await db()
      .select()
      .from(taskExtensions)
      .where(eq(taskExtensions.taskId, taskId))
      .orderBy(desc(taskExtensions.requestedAt))
      .limit(1)
    if (!row) return null
    const people = await refsOf([row.requestedBy, row.decidedBy])
    return {
      id: row.id,
      status: row.status as TaskExtensionStatus,
      fromDueAt: row.fromDue,
      requestedDueAt: row.requestedDue,
      requestedWorkingDays: row.requestedWorkingDays,
      reason: row.reason,
      requestedBy: row.requestedBy ? (people.get(row.requestedBy) ?? null) : null,
      requestedAt: row.requestedAt,
      decidedBy: row.decidedBy ? (people.get(row.decidedBy) ?? null) : null,
      decidedAt: row.decidedAt,
      decisionComment: row.decisionComment,
      approvedDueAt: row.approvedDue,
    }
  },
}

async function pendingOf(tx: Executor, taskId: string, lock = false): Promise<ExtensionRow | null> {
  const query = tx
    .select()
    .from(taskExtensions)
    .where(and(eq(taskExtensions.taskId, taskId), eq(taskExtensions.status, 'pending')))
    .limit(1)
  const [row] = lock ? await query.for('update') : await query
  return row ?? null
}
