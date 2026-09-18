import type { EventEnvelope } from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { recordModuleActivity } from '~/kernel/activity/service.js'
import type { Subscriber } from '~/kernel/events/types.js'
import { InboxService } from '~/kernel/inbox/service.js'
import { NotificationService } from '~/kernel/notifications/service.js'
import { emitToRoom } from '~/kernel/realtime/gateway.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { tasks } from '~/shared/db/schema/index.js'
import { refreshViewers } from './task-access.js'

/** Записи ленты по событиям задачи; создание пишет ядро (`object.created`). */
const ACTIVITY: Record<string, { verb: string; key: string }> = {
  'task.assigned': { verb: 'assigned', key: 'activity.task.assigned' },
  'task.accepted': { verb: 'accepted', key: 'activity.task.accepted' },
  'task.status_changed': { verb: 'status_changed', key: 'activity.task.statusChanged' },
  'task.due_changed': { verb: 'due_changed', key: 'activity.task.dueChanged' },
  'task.reported': { verb: 'reported', key: 'activity.task.reported' },
  'task.completed': { verb: 'completed', key: 'activity.task.completed' },
  'task.returned': { verb: 'returned', key: 'activity.task.returned' },
}

async function participants(taskId: string) {
  const [row] = await db()
    .select({
      kind: tasks.kind,
      authorId: tasks.authorId,
      assigneeId: tasks.assigneeId,
      coAssignees: tasks.coAssignees,
      controllerId: tasks.controllerId,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  return row ?? null
}

const people = (...ids: Array<string | null | undefined>): string[] =>
  ids.filter((id): id is string => typeof id === 'string')

/** Уведомления по категории `tasks` (10-tasks-projects.md §8); себе о своём действии — нет. */
async function notify(event: EventEnvelope): Promise<void> {
  if (!event.object) return
  const task = await participants(event.object.id)
  if (!task) return
  const base = {
    category: 'tasks' as const,
    objectId: event.object.id,
    actorId: event.actor.userId,
    url: `/o/${event.object.id}`,
    params: { title: event.object.title ?? '' },
  }
  switch (event.type) {
    case 'task.assigned':
      await NotificationService.notify({
        ...base,
        userIds: people(event.payload.assigneeId as string),
        titleKey: 'notifications.tpl.taskAssigned',
      })
      break
    case 'task.accepted':
      await NotificationService.notify({
        ...base,
        userIds: people(task.authorId),
        titleKey: 'notifications.tpl.taskAccepted',
      })
      break
    case 'task.reported':
      await NotificationService.notify({
        ...base,
        userIds: people(task.authorId, task.controllerId),
        titleKey: 'notifications.tpl.taskReported',
      })
      break
    case 'task.completed':
      await NotificationService.notify({
        ...base,
        // Поручение принято — исполнителям; задача готова — автору
        userIds:
          task.kind === 'instruction'
            ? people(task.assigneeId, ...task.coAssignees)
            : people(task.authorId),
        titleKey:
          task.kind === 'instruction'
            ? 'notifications.tpl.taskCompleted'
            : 'notifications.tpl.taskDone',
      })
      break
    case 'task.returned':
      await NotificationService.notify({
        ...base,
        userIds: people(task.assigneeId),
        titleKey: 'notifications.tpl.taskReturned',
      })
      break
    default:
      break
  }
}

async function activity(event: EventEnvelope): Promise<void> {
  const mapping = ACTIVITY[event.type]
  if (!mapping || !event.object) return
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

/** Задача или все задачи проекта — после смены прав пересчитываются принципалы. */
async function refreshAccess(event: EventEnvelope): Promise<void> {
  if (!event.object) return
  if (event.object.type === 'task') {
    await refreshViewers(db(), event.object.id)
    return
  }
  if (event.object.type !== 'project') return
  const rows = await db()
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.projectId, event.object.id))
  for (const row of rows) await refreshViewers(db(), row.id)
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
  if (!event.object) return
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
    types: ['task.assigned', 'task.accepted', 'task.reported', 'task.completed', 'task.returned'],
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
    name: 'tasks-trash',
    types: ['object.trashed'],
    handle: dismissTrashed,
  },
]
