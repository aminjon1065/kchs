import type { InboxItem, InboxKind } from '@kchs/contracts'
import { InboxService } from '~/kernel/inbox/service.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'

type InboxPriority = 'low' | 'normal' | 'high' | 'urgent'

/** P1 → срочно, P2 → высокий, P3 → обычный, P4 → низкий. */
const PRIORITY: Record<number, InboxPriority> = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' }

/** Запрос продления — из дела исполнителя: дата и обоснование (ADR-0082). */
const EXTEND: InboxItem['actions'][number] = {
  key: 'extend',
  labelKey: 'inbox.actions.extend',
  variant: 'secondary',
  requiresComment: true,
  input: 'due_date',
}

type TaskInboxKind = 'accept_instruction' | 'report_instruction' | 'accept_result' | 'extend_due'

const ACTIONS: Record<TaskInboxKind, InboxItem['actions']> = {
  accept_instruction: [
    { key: 'accept', labelKey: 'inbox.actions.accept', variant: 'primary', requiresComment: false },
    EXTEND,
  ],
  report_instruction: [
    { key: 'report', labelKey: 'inbox.actions.report', variant: 'primary', requiresComment: true },
    EXTEND,
  ],
  accept_result: [
    {
      key: 'accept',
      labelKey: 'inbox.actions.acceptResult',
      variant: 'primary',
      requiresComment: false,
    },
    {
      key: 'return',
      labelKey: 'inbox.actions.return',
      variant: 'secondary',
      requiresComment: true,
    },
  ],
  extend_due: [
    {
      key: 'approve',
      labelKey: 'inbox.actions.approveExtension',
      variant: 'primary',
      requiresComment: false,
    },
    {
      key: 'reject',
      labelKey: 'inbox.actions.rejectExtension',
      variant: 'danger',
      requiresComment: true,
    },
  ],
}

export interface InboxTask {
  id: string
  authorId: string | null
  assigneeId: string | null
  controllerId: string | null
  dueAt: string | null
  priority: number
  /** Часть соисполнителя: отчёт принимает контролёр — ответственный исполнитель. */
  isPart?: boolean
}

/**
 * Этапы поручения во Входящих (10-tasks-projects.md §4): назначено →
 * исполнителю «принять»; принято → «отчитаться»; отчёт → автору и контролёру
 * «принять отчёт / вернуть» (отчёт по части соисполнителя — контролёру, то есть
 * ответственному исполнителю); запрос продления → автору «согласовать /
 * отказать»; принято или отменено → всё закрыто.
 */
export const TaskInbox = {
  /** Исполнителю: принять поручение к исполнению. */
  async assigned(tx: Executor, ctx: Ctx, task: InboxTask): Promise<void> {
    if (!task.assigneeId) return
    await open(tx, ctx, task, task.assigneeId, 'accept_instruction', 'inbox.tpl.acceptInstruction')
  },

  /** Исполнителю: отчитаться (после принятия или возврата на доработку). */
  async toReport(tx: Executor, ctx: Ctx, task: InboxTask, returned = false): Promise<void> {
    if (!task.assigneeId) return
    await open(
      tx,
      ctx,
      task,
      task.assigneeId,
      'report_instruction',
      returned ? 'inbox.tpl.returnedInstruction' : 'inbox.tpl.reportInstruction',
    )
  },

  /** Автору и контролёру: принять отчёт или вернуть. */
  async reported(tx: Executor, ctx: Ctx, task: InboxTask): Promise<void> {
    for (const userId of reviewersOf(task)) {
      await open(tx, ctx, task, userId, 'accept_result', 'inbox.tpl.acceptResult')
    }
  },

  /** Автору (решает по продлению): согласовать новый срок или отказать. */
  async extensionRequested(
    tx: Executor,
    ctx: Ctx,
    task: InboxTask,
    deciderId: string,
    request: { extensionId: string; requestedDueAt: string; reason: string },
  ): Promise<void> {
    await open(tx, ctx, task, deciderId, 'extend_due', 'inbox.tpl.extendDue', request)
  },

  /** Закрыть элементы задачи: вида (всем получателям) или все сразу. */
  async close(
    tx: Executor,
    ctx: Ctx,
    taskId: string,
    selector: { kind?: InboxKind; userId?: string } = {},
    outcome: 'resolved' | 'dismissed' = 'resolved',
  ): Promise<void> {
    await InboxService.resolve(tx, ctx, { objectId: taskId, ...selector }, outcome)
  },
}

/** Кто принимает отчёт: у основного поручения — автор и контролёр, у части — контролёр. */
export function reviewersOf(task: InboxTask): string[] {
  const candidates =
    task.isPart && task.controllerId ? [task.controllerId] : [task.authorId, task.controllerId]
  return [...new Set(candidates)].filter((id): id is string => typeof id === 'string')
}

async function open(
  tx: Executor,
  ctx: Ctx,
  task: InboxTask,
  userId: string,
  kind: TaskInboxKind,
  titleKey: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await InboxService.open(tx, ctx, {
    userId,
    kind,
    objectId: task.id,
    titleKey,
    payload,
    dueAt: task.dueAt,
    priority: PRIORITY[task.priority] ?? 'normal',
    dedupeKey: `task:${task.id}:${kind}`,
    actions: ACTIONS[kind],
  })
}
