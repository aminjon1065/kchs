import type { EventEnvelope } from '@kchs/contracts'
import { and, arrayContains, eq, or } from 'drizzle-orm'
import { primaryUnitOf, UNIT_HEAD_PRINCIPAL } from '~/kernel/access/principal-set.js'
import { recordModuleActivity } from '~/kernel/activity/service.js'
import type { Subscriber } from '~/kernel/events/types.js'
import { InboxService } from '~/kernel/inbox/service.js'
import { NotificationService } from '~/kernel/notifications/service.js'
import { emitToRoom } from '~/kernel/realtime/gateway.js'
import { indexObjects } from '~/kernel/search/index-service.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { tasks } from '~/shared/db/schema/index.js'
import { refreshViewers } from './task-access.js'
import { CLOSED } from './task-core.js'

/** Записи ленты по событиям задачи; создание пишет ядро (`object.created`). */
const ACTIVITY: Record<string, { verb: string; key: string }> = {
  'task.assigned': { verb: 'assigned', key: 'activity.task.assigned' },
  'task.accepted': { verb: 'accepted', key: 'activity.task.accepted' },
  'task.status_changed': { verb: 'status_changed', key: 'activity.task.statusChanged' },
  'task.due_changed': { verb: 'due_changed', key: 'activity.task.dueChanged' },
  'task.reported': { verb: 'reported', key: 'activity.task.reported' },
  'task.completed': { verb: 'completed', key: 'activity.task.completed' },
  'task.returned': { verb: 'returned', key: 'activity.task.returned' },
  'task.extension_requested': {
    verb: 'extension_requested',
    key: 'activity.task.extensionRequested',
  },
  'task.overdue': { verb: 'overdue', key: 'activity.task.overdue' },
  'task.escalated': { verb: 'escalated', key: 'activity.task.escalated' },
}

async function participants(taskId: string) {
  const [row] = await db()
    .select({
      kind: tasks.kind,
      parentId: tasks.parentId,
      authorId: tasks.authorId,
      assigneeId: tasks.assigneeId,
      coAssignees: tasks.coAssignees,
      controllerId: tasks.controllerId,
      priority: tasks.priority,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  return row ?? null
}

/** «P1 · срочно» — высший приоритет поручения (10-tasks-projects.md, ADR-0082). */
const URGENT_PRIORITY = 1

const people = (...ids: Array<string | null | undefined>): string[] =>
  ids.filter((id): id is string => typeof id === 'string')

/**
 * Уведомления по категории `tasks` (10-tasks-projects.md §8, ADR-0082): назначение,
 * отчёт, приёмка, возврат, продление, напоминания о сроке, просрочка,
 * эскалация; себе о своём действии — нет.
 */
async function notify(event: EventEnvelope): Promise<void> {
  if (event.object?.type !== 'task') return
  const task = await participants(event.object.id)
  if (!task) return
  const base = {
    category: 'tasks' as const,
    objectId: event.object.id,
    actorId: event.actor.userId,
    url: `/o/${event.object.id}`,
    params: { title: event.object.title ?? '' },
  }
  // Срочное поручение (P1) и эскалация проходят сквозь тихие часы и «не беспокоить» (ADR-0140)
  const urgentTask = task.priority === URGENT_PRIORITY
  const send = (
    userIds: string[],
    titleKey: string,
    params: Record<string, unknown> = {},
    options: { escalation?: boolean } = {},
  ) =>
    NotificationService.notify({
      ...base,
      userIds,
      titleKey,
      params: { ...base.params, ...params },
      // Напоминания одного поручения не сливаются с назначением и отчётом
      aggregateKey: `tasks:${event.object?.id ?? ''}:${titleKey}`,
      urgent: urgentTask || Boolean(options.escalation),
    })
  // Отчёт по части соисполнителя принимает ответственный исполнитель (контролёр части)
  const reviewers = task.parentId
    ? people(task.controllerId)
    : people(task.authorId, task.controllerId)

  switch (event.type) {
    case 'task.assigned': {
      await send(people(event.payload.assigneeId as string), 'notifications.tpl.taskAssigned')
      const previous = event.payload.previousAssigneeId as string | null | undefined
      if (previous) await send(people(previous), 'notifications.tpl.taskReassignedAway')
      break
    }
    case 'task.accepted':
      await send(
        people(task.parentId ? task.controllerId : task.authorId),
        'notifications.tpl.taskAccepted',
      )
      break
    case 'task.reported':
      await send(reviewers, 'notifications.tpl.taskReported')
      break
    case 'task.report_prepared':
      await send(people(task.assigneeId), 'notifications.tpl.taskReportPrepared')
      break
    case 'task.completed':
      // Поручение принято — исполнителю; задача готова — автору
      await send(
        task.kind === 'instruction' ? people(task.assigneeId) : people(task.authorId),
        task.kind === 'instruction'
          ? 'notifications.tpl.taskCompleted'
          : 'notifications.tpl.taskDone',
      )
      break
    case 'task.returned':
      await send(people(task.assigneeId), 'notifications.tpl.taskReturned')
      break
    case 'task.extension_requested':
      await send(
        people(task.authorId ?? task.controllerId),
        'notifications.tpl.taskExtensionRequested',
      )
      break
    case 'task.extension_decided':
      await send(
        people(task.assigneeId),
        event.payload.decision === 'approved'
          ? 'notifications.tpl.taskExtensionApproved'
          : 'notifications.tpl.taskExtensionRejected',
      )
      break
    case 'task.due_soon':
      await send(
        people(task.assigneeId),
        event.payload.stage === 'today'
          ? 'notifications.tpl.taskDueToday'
          : 'notifications.tpl.taskDueSoon',
        { days: Number(event.payload.workingDaysLeft ?? 0) },
      )
      break
    case 'task.overdue':
      await send(people(task.assigneeId), 'notifications.tpl.taskOverdue')
      await send(
        people(task.authorId, task.controllerId).filter((id) => id !== task.assigneeId),
        'notifications.tpl.taskOverdueIssued',
      )
      break
    case 'task.escalated': {
      // Руководитель, который и так узнал о просрочке (автор, контролёр), — без повтора
      const managerId = event.payload.managerId as string
      const informed = new Set(people(task.authorId, task.controllerId, task.assigneeId))
      if (!informed.has(managerId)) {
        await send([managerId], 'notifications.tpl.taskEscalated', {}, { escalation: true })
      }
      break
    }
    default:
      break
  }
}

async function activity(event: EventEnvelope): Promise<void> {
  if (event.object?.type !== 'task') return
  if (event.type === 'task.extension_decided') {
    const approved = event.payload.decision === 'approved'
    await recordModuleActivity(event, {
      verb: approved ? 'extension_approved' : 'extension_rejected',
      key: approved ? 'activity.task.extensionApproved' : 'activity.task.extensionRejected',
    })
    return
  }
  const mapping = ACTIVITY[event.type]
  if (!mapping) return
  // Шаги поручения (принято, отчёт, возврат, приёмка) лента пишет по своим
  // событиям; из смен статуса поручения — только отмену
  if (
    event.type === 'task.status_changed' &&
    event.payload.kind === 'instruction' &&
    event.payload.to !== 'cancelled'
  ) {
    return
  }
  await recordModuleActivity(event, mapping)
}

/** Задача и её части — после смены прав пересчитываются принципалы; проекта — все задачи. */
async function refreshAccess(event: EventEnvelope): Promise<void> {
  if (!event.object) return
  if (event.object.type === 'task') {
    await refreshViewers(db(), event.object.id)
    // Части соисполнителей наследуют права основного поручения
    const parts = await db()
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.parentId, event.object.id))
    for (const part of parts) await refreshViewers(db(), part.id)
    return
  }
  if (event.object.type !== 'project') return
  const rows = await db()
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.projectId, event.object.id))
  for (const row of rows) await refreshViewers(db(), row.id)
}

/**
 * Оргструктура изменилась: руководители исполнителя (принципалы `unit_head`)
 * и подразделение открытых поручений пересчитываются. Сотрудник перешёл —
 * его поручения; подразделение перенесено или изменено — поручения, где оно в
 * цепочке подразделений исполнителя.
 */
async function refreshOrg(event: EventEnvelope): Promise<void> {
  const conditions =
    event.type === 'org.employment_changed'
      ? [eq(tasks.assigneeId, event.payload.userId as string)]
      : [arrayContains(tasks.viewers, [`${UNIT_HEAD_PRINCIPAL}:${event.payload.unitId as string}`])]
  const rows = await db()
    .select({ id: tasks.id, assigneeId: tasks.assigneeId, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.kind, 'instruction'), or(...conditions)))
  for (const row of rows) {
    await refreshViewers(db(), row.id)
    // Закрытое поручение остаётся в подразделении, где его исполнили
    if (row.assigneeId && !CLOSED.includes(row.status)) {
      const unitId = await primaryUnitOf(row.assigneeId)
      await db().update(tasks).set({ unitId }).where(eq(tasks.id, row.id))
    }
  }
  // Фильтр поиска — те же принципалы, что у системных датасетов
  if (rows.length > 0) await indexObjects(rows.map((row) => row.id))
}

/** Задача в корзине — её дела во Входящих больше не ждут действия. */
async function dismissTrashed(event: EventEnvelope): Promise<void> {
  if (event.object?.type !== 'task') return
  await InboxService.resolve(
    db(),
    systemCtx('tasks.trashed'),
    { objectId: event.object.id },
    'dismissed',
  )
}

/** Открытые вкладки задачи перечитывают её (ключи запросов `['object', id, …]`). */
function refreshTabs(event: EventEnvelope): void {
  if (event.object?.type !== 'task') return
  emitToRoom(`object:${event.object.id}`, 'object.updated', {
    id: event.object.id,
    type: 'task',
    version: 0,
    changedFields: ['task'],
    actorId: event.actor.userId,
  })
}

export const taskSubscribers: Subscriber[] = [
  {
    name: 'tasks-notifications',
    types: [
      'task.assigned',
      'task.accepted',
      'task.reported',
      'task.report_prepared',
      'task.completed',
      'task.returned',
      'task.extension_requested',
      'task.extension_decided',
      'task.due_soon',
      'task.overdue',
      'task.escalated',
    ],
    handle: notify,
  },
  {
    name: 'tasks-activity',
    types: ['task.*'],
    handle: activity,
  },
  {
    name: 'tasks-realtime',
    types: ['task.*'],
    handle: async (event) => refreshTabs(event),
  },
  {
    name: 'tasks-viewers',
    types: ['acl.changed', 'object.moved'],
    handle: refreshAccess,
  },
  {
    name: 'tasks-org',
    types: ['org.employment_changed', 'org.unit_changed'],
    handle: refreshOrg,
  },
  {
    name: 'tasks-trash',
    types: ['object.trashed'],
    handle: dismissTrashed,
  },
]
