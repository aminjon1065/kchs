import {
  TASK_CHECKLIST_MAX,
  type TaskChecklistAddInput,
  type TaskChecklistItem,
  type TaskChecklistPatchInput,
  type TaskProgress,
  type TaskStatus,
  type TaskSubtask,
  type TaskSubtaskCreateInput,
} from '@kchs/contracts'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { authorize, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { actorId, type Ctx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, type TaskChecklistValue, tasks } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import {
  actorOf,
  assertPeople,
  CLOSED,
  emit,
  factsOf,
  loadRow,
  projectInfo,
  refsOf,
  selectTasks,
  type TaskRow,
} from './task-core.js'
import { insertTask } from './task-create.js'
import { resolveDue } from './task-due.js'
import { isOverdue, permissionsFor } from './task-rules.js'

type ChecklistChange = 'added' | 'checked' | 'unchecked' | 'renamed' | 'moved' | 'removed'

/** Строка задачи под блокировкой и право вести её чек-лист или подзадачи. */
async function guarded(
  tx: Executor,
  ctx: Ctx,
  id: string,
  right: 'checklist' | 'subtasks',
): Promise<TaskRow> {
  const decision = await authorize(ctx, 'view', id)
  const row = await loadRow(tx, id, true)
  if (!row) throw errors.notFound('Задача')
  const projectMap = await projectInfo(tx, row.projectId ? [row.projectId] : [])
  const facts = factsOf(row, row.projectId ? projectMap.get(row.projectId) : null)
  const can = permissionsFor(facts, actorOf(ctx), decision.level)
  if (!can[right]) {
    throw right === 'subtasks'
      ? errors.forbidden('Подзадачи добавляет тот, кто правит обычную задачу')
      : errors.forbidden(
          'Чек-лист ведут исполнитель, автор и контролёр поручения или тот, кто правит задачу',
        )
  }
  return row
}

export function checklistProgress(items: readonly TaskChecklistValue[]): TaskProgress | null {
  if (items.length === 0) return null
  return { done: items.filter((item) => item.done).length, total: items.length }
}

/** Запись чек-листа: строка задачи, прогресс в `meta` реестра (версия объекта растёт), событие. */
async function saveChecklist(
  tx: Executor,
  ctx: Ctx,
  row: TaskRow,
  items: TaskChecklistValue[],
  change: ChecklistChange,
  itemText: string,
): Promise<void> {
  await tx.update(tasks).set({ checklist: items }).where(eq(tasks.id, row.id))
  const progress = checklistProgress(items)
  await ObjectService.update(
    tx,
    ctx,
    row.id,
    { meta: { checklist: progress }, mergeMeta: true },
    { silent: true },
  )
  await emit(
    tx,
    ctx,
    { id: row.id, spaceId: row.spaceId, title: row.title },
    'task.checklist_changed',
    {
      key: row.key,
      done: progress?.done ?? 0,
      total: progress?.total ?? 0,
      change,
      item: itemText.slice(0, 200),
    },
  )
}

function moved<T>(items: T[], from: number, to: number): T[] {
  const next = [...items]
  const [item] = next.splice(from, 1)
  if (item !== undefined) next.splice(Math.min(to, next.length), 0, item)
  return next
}

/**
 * Чек-лист задачи и поручения (ADR-0155): шаги исполнения по порядку. Каждое действие —
 * под блокировкой строки задачи, чтобы отметки исполнителя и правки автора не затирали
 * друг друга.
 */
export const TaskChecklist = {
  async add(tx: Executor, ctx: Ctx, id: string, input: TaskChecklistAddInput): Promise<string> {
    const row = await guarded(tx, ctx, id, 'checklist')
    if (row.checklist.length >= TASK_CHECKLIST_MAX) {
      throw errors.validation(
        `В чек-листе не больше ${TASK_CHECKLIST_MAX} пунктов — разбейте работу на подзадачи`,
      )
    }
    const item: TaskChecklistValue = {
      id: newId(),
      text: input.text,
      done: false,
      doneAt: null,
      doneBy: null,
    }
    const items = [...row.checklist]
    items.splice(Math.min(input.position ?? items.length, items.length), 0, item)
    await saveChecklist(tx, ctx, row, items, 'added', item.text)
    return item.id
  },

  async patch(
    tx: Executor,
    ctx: Ctx,
    id: string,
    itemId: string,
    input: TaskChecklistPatchInput,
  ): Promise<void> {
    const row = await guarded(tx, ctx, id, 'checklist')
    const index = row.checklist.findIndex((item) => item.id === itemId)
    const current = row.checklist[index]
    if (!current) throw errors.notFound('Пункт чек-листа')
    let items = [...row.checklist]
    let change: ChecklistChange = 'renamed'
    const next: TaskChecklistValue = { ...current }
    if (input.text !== undefined) next.text = input.text
    if (input.done !== undefined && input.done !== current.done) {
      next.done = input.done
      next.doneAt = input.done ? new Date().toISOString() : null
      next.doneBy = input.done ? actorId(ctx) : null
      change = input.done ? 'checked' : 'unchecked'
    }
    items[index] = next
    if (input.position !== undefined && input.position !== index) {
      items = moved(items, index, input.position)
      if (input.done === undefined && input.text === undefined) change = 'moved'
    }
    await saveChecklist(tx, ctx, row, items, change, next.text)
  },

  async remove(tx: Executor, ctx: Ctx, id: string, itemId: string): Promise<void> {
    const row = await guarded(tx, ctx, id, 'checklist')
    const item = row.checklist.find((entry) => entry.id === itemId)
    if (!item) throw errors.notFound('Пункт чек-листа')
    const items = row.checklist.filter((entry) => entry.id !== itemId)
    await saveChecklist(tx, ctx, row, items, 'removed', item.text)
  },

  /** Пункты для карточки: кто отметил — ссылкой на сотрудника. */
  async itemsOf(row: TaskRow): Promise<TaskChecklistItem[]> {
    const people = await refsOf(row.checklist.map((item) => item.doneBy))
    return row.checklist.map((item) => ({
      id: item.id,
      text: item.text,
      done: item.done,
      doneAt: item.doneAt,
      doneBy: item.doneBy ? (people.get(item.doneBy) ?? null) : null,
    }))
  },
}

/**
 * Подзадачи обычной задачи (ADR-0155): дочерние задачи вида `subtask` со своим
 * исполнителем и сроком. В реестре — дочерний объект задачи и наследует её права.
 * У поручения подзадач нет: работу делят части соисполнителей, шаги исполнителя —
 * чек-лист.
 */
export const TaskSubtasks = {
  async create(
    tx: Executor,
    ctx: Ctx,
    parentId: string,
    input: TaskSubtaskCreateInput,
  ): Promise<string> {
    const parent = await guarded(tx, ctx, parentId, 'subtasks')
    const authorId = actorId(ctx)
    if (!authorId) throw errors.validation('У подзадачи должен быть автор')
    const assigneeId = input.assigneeId ?? parent.assigneeId ?? authorId
    await assertPeople([...new Set([authorId, assigneeId])])
    const project = parent.projectId
      ? ((await projectInfo(tx, [parent.projectId])).get(parent.projectId) ?? null)
      : null
    const due = input.dueAt ? await resolveDue({ dueAt: input.dueAt }, new Date(), tx) : null
    return insertTask(tx, ctx, {
      kind: 'subtask',
      title: input.title,
      description: null,
      project,
      spaceId: parent.spaceId ?? '',
      registryParentId: parent.id,
      accessMode: 'inherit',
      authorId,
      assigneeId,
      coAssignees: [],
      controllerId: null,
      due: due ?? null,
      priority: 3,
      labels: [],
      source: null,
      sourceObjectId: null,
      territoryId: parent.territoryId,
      parentTaskId: parent.id,
    })
  },

  /** Подзадачи для карточки задачи — видимые смотрящему. */
  async of(ctx: UserCtx, row: TaskRow): Promise<TaskSubtask[]> {
    if (row.kind !== 'task') return []
    const rows = await selectTasks(db())
      .where(
        and(
          eq(tasks.parentId, row.id),
          eq(tasks.kind, 'subtask'),
          sql`${objects.deletedAt} IS NULL`,
          visibleObjectsSql(ctx, 'task'),
        ),
      )
      .orderBy(asc(objects.createdAt))
    const people = await refsOf(rows.map((child) => child.assigneeId))
    return rows.map((child) => ({
      id: child.id,
      key: child.key,
      title: child.title,
      status: child.status as TaskStatus,
      assignee: child.assigneeId ? (people.get(child.assigneeId) ?? null) : null,
      dueAt: child.dueAt,
      overdue: isOverdue(child.status as TaskStatus, child.dueAt, new Date(), child.reportedAt),
      completedAt: child.completedAt,
    }))
  },

  /** Прогресс подзадач по задачам списка одним запросом. */
  async progress(ids: string[]): Promise<Map<string, TaskProgress>> {
    if (ids.length === 0) return new Map()
    const rows = await db()
      .select({
        parentId: tasks.parentId,
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) FILTER (WHERE ${inArray(tasks.status, CLOSED)})::int`,
      })
      .from(tasks)
      .innerJoin(objects, eq(objects.id, tasks.id))
      .where(
        and(
          inArray(tasks.parentId, ids),
          eq(tasks.kind, 'subtask'),
          sql`${objects.deletedAt} IS NULL`,
        ),
      )
      .groupBy(tasks.parentId)
    return new Map(
      rows.flatMap((row) =>
        row.parentId ? [[row.parentId, { done: row.done, total: row.total }] as const] : [],
      ),
    )
  },
}
