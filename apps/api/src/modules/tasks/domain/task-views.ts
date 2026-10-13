import type {
  Level,
  TaskKind,
  TaskListItem,
  TaskPart,
  TaskProgress,
  TaskRecord,
  TaskReportDraft,
  TaskResultObject,
  TaskStatus,
  UserRef,
} from '@kchs/contracts'
import { and, asc, eq, isNull, type SQL, sql } from 'drizzle-orm'
import { authorize, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { objects } from '~/kernel/objects/schema.js'
import { ObjectService } from '~/kernel/objects/service.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { tasks } from '../schema.js'
import { approximateLevel } from './task-access.js'
import { checklistProgress, TaskSubtasks } from './task-checklist.js'
import {
  actorOf,
  factsOf,
  loadRow,
  type ProjectInfo,
  projectInfo,
  refsOf,
  selectTasks,
  type TaskRow,
} from './task-core.js'
import type { InboxTask } from './task-inbox.js'
import { isOverdue, permissionsFor, type TaskActor } from './task-rules.js'

/**
 * Представления задачи (ADR-0082): строка списка и карточка — люди, части соисполнителей,
 * серия, родитель, результаты и черновик отчёта; запись во Входящих.
 */

/** Ссылки на людей задачи одним запросом к справочнику. */
export async function peopleOf(rows: TaskRow[]): Promise<Map<string, UserRef>> {
  return refsOf(
    rows.flatMap((row) => [
      row.authorId,
      row.assigneeId,
      row.controllerId,
      ...row.coAssignees,
      row.result?.reportedBy ?? null,
    ]),
  )
}

export function listItemOf(
  row: TaskRow,
  people: Map<string, UserRef>,
  project: ProjectInfo | null | undefined,
  level: Level,
  actor: TaskActor,
  pendingExtension = false,
  subtaskProgress: TaskProgress | null = null,
): TaskListItem {
  const status = row.status as TaskStatus
  return {
    id: row.id,
    key: row.key,
    kind: row.kind as TaskKind,
    title: row.title,
    status,
    priority: row.priority,
    author: row.authorId ? (people.get(row.authorId) ?? null) : null,
    assignee: row.assigneeId ? (people.get(row.assigneeId) ?? null) : null,
    project: project ? { id: project.id, key: project.key, name: project.name } : null,
    spaceId: row.spaceId,
    startAt: row.startAt,
    dueAt: row.dueAt,
    dueWorkingDays: row.dueWorkingDays,
    originalDueAt: row.originalDueAt,
    extensions: row.extensions,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    labels: row.labels,
    territoryId: row.territoryId,
    overdue: isOverdue(status, row.dueAt, new Date(), row.reportedAt),
    parentId: row.parentId,
    checklistProgress: checklistProgress(row.checklist),
    subtaskProgress,
    seriesId: row.seriesId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
    can: permissionsFor(factsOf(row, project, pendingExtension), actor, level),
  }
}
/**
 * «Мои»: исполняю; у обычной задачи — и соисполняю. Соисполнитель поручения
 * исполняет свою часть — она и есть его поручение (ADR-0082).
 */
export function mineSql(me: string): SQL {
  return sql`(${tasks.assigneeId} = ${me}
    OR (${tasks.kind} <> 'instruction' AND ${me} = ANY(${tasks.coAssignees})))`
}

/** Строки списка с правами смотрящего (оценка для кнопок) и ожидающими продлениями. */
export async function listItems(ctx: Ctx, rows: TaskRow[]): Promise<TaskListItem[]> {
  if (rows.length === 0) return []
  const [people, projectMap, pending, subtasks] = await Promise.all([
    peopleOf(rows),
    projectInfo(db(), [
      ...new Set(rows.map((row) => row.projectId).filter((id): id is string => Boolean(id))),
    ]),
    pendingExtensions(rows.map((row) => row.id)),
    TaskSubtasks.progress(rows.filter((row) => row.kind === 'task').map((row) => row.id)),
  ])
  const actor = actorOf(ctx)
  return rows.map((row) =>
    listItemOf(
      row,
      people,
      row.projectId ? projectMap.get(row.projectId) : null,
      ctx.kind === 'user' ? approximateLevel(ctx, row) : 'owner',
      actor,
      pending.has(row.id),
      subtasks.get(row.id) ?? null,
    ),
  )
}

async function pendingExtensions(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await db().execute<{ task_id: string }>(
    sql`SELECT task_id FROM task_extensions WHERE status = 'pending'
         AND task_id IN (${sql.join(
           ids.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})`,
  )
  return new Set(rows.map((row) => row.task_id))
}

export function inboxTaskOf(row: TaskRow): InboxTask {
  return {
    id: row.id,
    authorId: row.authorId,
    assigneeId: row.assigneeId,
    controllerId: row.controllerId,
    dueAt: row.dueAt,
    priority: row.priority,
    isPart: row.parentId !== null,
  }
}
/** Части соисполнителей основного поручения, видимые смотрящему. */
export async function partsOf(ctx: UserCtx, row: TaskRow): Promise<TaskPart[]> {
  if (row.kind !== 'instruction' || row.parentId) return []
  const rows = await selectTasks(db())
    .where(
      and(
        eq(tasks.parentId, row.id),
        sql`${objects.deletedAt} IS NULL`,
        visibleObjectsSql(ctx, 'task'),
      ),
    )
    .orderBy(asc(objects.createdAt))
  const people = await refsOf(rows.map((part) => part.assigneeId))
  return rows.map((part) => ({
    id: part.id,
    key: part.key,
    status: part.status as TaskStatus,
    assignee: part.assigneeId ? (people.get(part.assigneeId) ?? null) : null,
    dueAt: part.dueAt,
    overdue: isOverdue(part.status as TaskStatus, part.dueAt, new Date(), part.reportedAt),
    completedAt: part.completedAt,
  }))
}

/** Серия экземпляра — название объекта серии (ADR-0156). */
export async function seriesOf(row: TaskRow): Promise<TaskRecord['series']> {
  if (!row.seriesId) return null
  const [series] = await db()
    .select({ id: objects.id, title: objects.title })
    .from(objects)
    .where(and(eq(objects.id, row.seriesId), isNull(objects.deletedAt)))
    .limit(1)
  return series ?? null
}

export async function parentOf(row: TaskRow): Promise<TaskRecord['parent']> {
  if (!row.parentId) return null
  const parent = await loadRow(db(), row.parentId)
  return parent ? { id: parent.id, key: parent.key, title: parent.title } : null
}

/**
 * Объекты отчёта: вложения и связанные объекты с названием, если смотрящий их
 * видит, иначе — «нет доступа» без названия.
 */
export async function resultObjectsOf(ctx: UserCtx, row: TaskRow): Promise<TaskResultObject[]> {
  return objectsOf(ctx, row.result?.objectIds ?? [])
}

/** Готовый отчёт — только исполнителю, пока поручение открыто (ADR-0136). */
export async function reportDraftOf(ctx: UserCtx, row: TaskRow): Promise<TaskReportDraft | null> {
  const draft = row.reportDraft
  if (!draft || row.assigneeId !== ctx.userId) return null
  if (row.status !== 'assigned' && row.status !== 'in_progress') return null
  return {
    text: draft.text,
    objects: await objectsOf(ctx, draft.objectIds),
    cause: draft.cause,
    preparedAt: draft.preparedAt,
  }
}

async function objectsOf(ctx: UserCtx, ids: string[]): Promise<TaskResultObject[]> {
  if (ids.length === 0) return []
  const summaries = await ObjectService.summaries(ids)
  const result: TaskResultObject[] = []
  for (const id of ids) {
    const summary = summaries.get(id)
    if (!summary) continue
    const decision = await authorize(ctx, 'view', id, { soft: true })
    result.push({ id, type: summary.type, title: decision.allowed ? summary.title : null })
  }
  return result
}
