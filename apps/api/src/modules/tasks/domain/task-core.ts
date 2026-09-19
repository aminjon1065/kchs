import { CLOSED_TASK_STATUSES, type TaskKind, TaskStatus, type UserRef } from '@kchs/contracts'
import { and, eq, inArray, notInArray, type SQL, sql } from 'drizzle-orm'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import type { EventInput } from '~/kernel/events/types.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { objects, projects, taskExtensions, tasks } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import type { TaskActor, TaskFacts } from './task-rules.js'

/**
 * Общее для служб модуля задач: строка задачи вместе с реестром, факты для
 * правил, события и ссылки на людей (ADR-0060, ADR-0082).
 */
export const TASK_COLUMNS = {
  id: tasks.id,
  kind: tasks.kind,
  key: tasks.key,
  projectId: tasks.projectId,
  parentId: tasks.parentId,
  status: tasks.status,
  priority: tasks.priority,
  assigneeId: tasks.assigneeId,
  coAssignees: tasks.coAssignees,
  authorId: tasks.authorId,
  controllerId: tasks.controllerId,
  dueAt: tasks.dueAt,
  dueWorkingDays: tasks.dueWorkingDays,
  originalDueAt: tasks.originalDueAt,
  dueSetAt: tasks.dueSetAt,
  extensions: tasks.extensions,
  unitId: tasks.unitId,
  startedAt: tasks.startedAt,
  reportedAt: tasks.reportedAt,
  completedAt: tasks.completedAt,
  description: tasks.description,
  result: tasks.result,
  returnComment: tasks.returnComment,
  source: tasks.source,
  labels: tasks.labels,
  territoryId: tasks.territoryId,
  title: objects.title,
  spaceId: objects.spaceId,
  ownerId: objects.ownerId,
  accessMode: objects.accessMode,
  createdAt: objects.createdAt,
  updatedAt: objects.updatedAt,
  version: objects.version,
}

/** Задача вместе со строкой реестра: название, пространство, владелец, версия. */
export function selectTasks(executor: Executor) {
  return executor.select(TASK_COLUMNS).from(tasks).innerJoin(objects, eq(objects.id, tasks.id))
}

export type TaskRow = Awaited<ReturnType<typeof selectTasks>>[number]

export interface ProjectInfo {
  id: string
  key: string
  name: string
  spaceId: string | null
  workflow: TaskStatus[]
}

export const CLOSED = [...CLOSED_TASK_STATUSES] as string[]

export async function loadRow(
  executor: Executor,
  id: string,
  lock = false,
): Promise<TaskRow | null> {
  const query = selectTasks(executor)
    .where(and(eq(tasks.id, id), sql`${objects.deletedAt} IS NULL`))
    .limit(1)
  const [row] = lock ? await query.for('update', { of: tasks }) : await query
  return row ?? null
}

export async function projectInfo(
  executor: Executor,
  ids: string[],
): Promise<Map<string, ProjectInfo>> {
  if (ids.length === 0) return new Map()
  const rows = await executor
    .select({
      id: projects.id,
      key: projects.key,
      name: objects.title,
      spaceId: objects.spaceId,
      workflow: projects.workflow,
    })
    .from(projects)
    .innerJoin(objects, eq(objects.id, projects.id))
    .where(inArray(projects.id, ids))
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        key: row.key,
        name: row.name,
        spaceId: row.spaceId,
        workflow: statusesOf(row.workflow.statuses),
      },
    ]),
  )
}

function statusesOf(values: unknown): TaskStatus[] {
  if (!Array.isArray(values)) return []
  return values.flatMap((value) => {
    const parsed = TaskStatus.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
}

/** Ждёт ли решения запрос продления — для кнопок и проверок. */
export async function hasPendingExtension(executor: Executor, taskId: string): Promise<boolean> {
  const [row] = await executor
    .select({ id: taskExtensions.id })
    .from(taskExtensions)
    .where(and(eq(taskExtensions.taskId, taskId), eq(taskExtensions.status, 'pending')))
    .limit(1)
  return Boolean(row)
}

export function factsOf(
  row: TaskRow,
  project: ProjectInfo | null | undefined,
  pendingExtension = false,
): TaskFacts {
  return {
    kind: row.kind as TaskKind,
    status: row.status as TaskStatus,
    authorId: row.authorId,
    assigneeId: row.assigneeId,
    coAssignees: row.coAssignees,
    controllerId: row.controllerId,
    pendingExtension,
    ...(project?.workflow.length ? { workflow: project.workflow } : {}),
  }
}

export function actorOf(ctx: Ctx): TaskActor {
  if (ctx.kind === 'user') return { userId: ctx.userId, onBehalfOf: ctx.onBehalfOf }
  return { userId: ctx.initiatorId ?? '' }
}

/** Участники — действующие сотрудники. */
export async function assertPeople(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const refs = await directory().refs(ids)
  for (const id of ids) {
    const ref = refs.get(id)
    if (!ref) throw errors.validation('Сотрудник не найден')
    if (ref.status === 'blocked' || ref.status === 'deactivated') {
      throw errors.validation(`Сотрудник «${ref.displayName}» заблокирован`)
    }
  }
}

/** Ссылки на людей одним запросом к справочнику. */
export async function refsOf(
  ids: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, UserRef>> {
  return directory().refs([...new Set(ids.filter((id): id is string => Boolean(id)))])
}

/** Краткое состояние задачи в реестре: для списков объектов и поиска. */
export function metaOf(row: {
  key: string
  kind: string
  status: string
  priority: number
  dueAt: string | null
  assigneeId: string | null
}): Record<string, unknown> {
  return {
    key: row.key,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    dueAt: row.dueAt,
    assigneeId: row.assigneeId,
  }
}

export interface TaskView {
  id: string
  spaceId: string | null
  title: string
}

export function viewOf(row: TaskRow): TaskView {
  return { id: row.id, spaceId: row.spaceId, title: row.title }
}

export async function emit(
  tx: Executor,
  ctx: Ctx,
  row: TaskView,
  type: EventInput['type'],
  payload: Record<string, unknown>,
): Promise<void> {
  await publishEvent(tx, ctx, {
    type,
    object: { id: row.id, type: 'task', spaceId: row.spaceId, title: row.title },
    payload,
  })
}

/**
 * Просрочена: срок прошёл, а задача не закрыта; отчёт поручения, сданный в
 * срок и ждущий приёмки, просрочкой не считается (исполнитель успел).
 */
export function overdueSql(now: SQL = sql`now()`): SQL {
  return sql`(${tasks.dueAt} IS NOT NULL AND ${notInArray(tasks.status, CLOSED)}
    AND COALESCE(CASE WHEN ${tasks.status} = 'reported' THEN ${tasks.reportedAt} END, ${now})
      > ${tasks.dueAt})`
}
