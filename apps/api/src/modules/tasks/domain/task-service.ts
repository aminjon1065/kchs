import {
  CLOSED_TASK_STATUSES,
  type Level,
  type TaskCancelInput,
  type TaskCreateInput,
  type TaskKind,
  type TaskListItem,
  type TaskListQuery,
  type TaskRecord,
  type TaskReportInput,
  type TaskReturnInput,
  type TaskSource,
  TaskStatus,
  type TaskSummary,
  type TaskUpdateInput,
  type UserRef,
} from '@kchs/contracts'
import { and, desc, eq, inArray, notInArray, type SQL, sql } from 'drizzle-orm'
import { authorize, loadObject, visibleObjectsSql } from '~/kernel/access/authorize.js'
import type { ObjectLike } from '~/kernel/access/types.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import type { EventInput } from '~/kernel/events/types.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { SpaceService } from '~/kernel/spaces/service.js'
import { actorId, type Ctx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, projects, tasks } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import {
  approximateLevel,
  participantsOf,
  refreshViewers,
  syncParticipants,
} from './task-access.js'
import { TaskInbox } from './task-inbox.js'
import { nextTaskKey } from './task-keys.js'
import {
  INSTRUCTION_ACTIONS,
  type InstructionAction,
  initialStatus,
  isClosed,
  isOverdue,
  permissionsFor,
  type TaskActor,
  type TaskFacts,
} from './task-rules.js'

const COLUMNS = {
  id: tasks.id,
  kind: tasks.kind,
  key: tasks.key,
  projectId: tasks.projectId,
  status: tasks.status,
  priority: tasks.priority,
  assigneeId: tasks.assigneeId,
  coAssignees: tasks.coAssignees,
  authorId: tasks.authorId,
  controllerId: tasks.controllerId,
  dueAt: tasks.dueAt,
  startedAt: tasks.startedAt,
  reportedAt: tasks.reportedAt,
  completedAt: tasks.completedAt,
  description: tasks.description,
  result: tasks.result,
  returnComment: tasks.returnComment,
  source: tasks.source,
  labels: tasks.labels,
  title: objects.title,
  spaceId: objects.spaceId,
  ownerId: objects.ownerId,
  accessMode: objects.accessMode,
  createdAt: objects.createdAt,
  updatedAt: objects.updatedAt,
  version: objects.version,
}

/** Задача вместе со строкой реестра: название, пространство, владелец, версия. */
function selectTasks(executor: Executor) {
  return executor.select(COLUMNS).from(tasks).innerJoin(objects, eq(objects.id, tasks.id))
}

type TaskRow = Awaited<ReturnType<typeof selectTasks>>[number]

interface ProjectInfo {
  id: string
  key: string
  name: string
  spaceId: string | null
  workflow: TaskStatus[]
}

const CLOSED = [...CLOSED_TASK_STATUSES] as string[]

async function loadRow(executor: Executor, id: string, lock = false): Promise<TaskRow | null> {
  const query = selectTasks(executor)
    .where(and(eq(tasks.id, id), sql`${objects.deletedAt} IS NULL`))
    .limit(1)
  const [row] = lock ? await query.for('update', { of: tasks }) : await query
  return row ?? null
}

async function projectInfo(executor: Executor, ids: string[]): Promise<Map<string, ProjectInfo>> {
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

function factsOf(row: TaskRow, project: ProjectInfo | null | undefined): TaskFacts {
  return {
    kind: row.kind as TaskKind,
    status: row.status as TaskStatus,
    authorId: row.authorId,
    assigneeId: row.assigneeId,
    coAssignees: row.coAssignees,
    controllerId: row.controllerId,
    ...(project?.workflow.length ? { workflow: project.workflow } : {}),
  }
}

function actorOf(ctx: Ctx): TaskActor {
  if (ctx.kind === 'user') return { userId: ctx.userId, onBehalfOf: ctx.onBehalfOf }
  return { userId: ctx.initiatorId ?? '' }
}

/** Ссылки на людей задачи одним запросом к справочнику. */
async function peopleOf(rows: TaskRow[]): Promise<Map<string, UserRef>> {
  const ids = new Set<string>()
  for (const row of rows) {
    for (const id of [row.authorId, row.assigneeId, row.controllerId, ...row.coAssignees]) {
      if (id) ids.add(id)
    }
    const reportedBy = row.result?.reportedBy
    if (reportedBy) ids.add(reportedBy)
  }
  return directory().refs([...ids])
}

function listItemOf(
  row: TaskRow,
  people: Map<string, UserRef>,
  project: ProjectInfo | null | undefined,
  level: Level,
  actor: TaskActor,
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
    dueAt: row.dueAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    labels: row.labels,
    overdue: isOverdue(status, row.dueAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
    can: permissionsFor(factsOf(row, project), actor, level),
  }
}

function recordOf(
  row: TaskRow,
  people: Map<string, UserRef>,
  project: ProjectInfo | null | undefined,
  level: Level,
  actor: TaskActor,
): TaskRecord {
  return {
    ...listItemOf(row, people, project, level, actor),
    description: row.description,
    coAssignees: row.coAssignees.flatMap((id) => {
      const ref = people.get(id)
      return ref ? [ref] : []
    }),
    controller: row.controllerId ? (people.get(row.controllerId) ?? null) : null,
    result: row.result
      ? {
          text: row.result.text,
          reportedAt: row.result.reportedAt,
          reportedBy: row.result.reportedBy ? (people.get(row.result.reportedBy) ?? null) : null,
        }
      : null,
    returnComment: row.returnComment,
    source: (row.source as TaskSource | null) ?? null,
  }
}

/** Участники — действующие сотрудники. */
async function assertPeople(ids: string[]): Promise<void> {
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

/** Краткое состояние задачи в реестре: для списков объектов и поиска. */
function metaOf(row: {
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

async function emit(
  tx: Executor,
  ctx: Ctx,
  row: { id: string; spaceId: string | null; title: string },
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
 * Пространство задачи без проекта: заданное явно (нужно право создавать в
 * нём); поручение — в пространстве источника (доступ всё равно только у
 * участников); иначе личное пространство автора.
 */
async function spaceFor(
  tx: Executor,
  ctx: Ctx,
  input: TaskCreateInput,
  source: ObjectLike | null,
  authorId: string,
): Promise<string> {
  if (input.spaceId) {
    await authorize(ctx, 'create_child', input.spaceId)
    return input.spaceId
  }
  if (input.kind === 'instruction' && source?.spaceId) return source.spaceId
  return SpaceService.ensurePersonal(tx, ctx, authorId, '')
}

function sourceObjectId(source: TaskSource | undefined): string | null {
  if (!source) return null
  return source.kind === 'dataset_row' ? source.datasetId : source.objectId
}

/**
 * Задачи и поручения (10-tasks-projects.md, ADR-0060): одна сущность, разные
 * правила. Создание — объект реестра, строка задачи, права участников, связь
 * с источником, события и Входящие исполнителя в одной транзакции.
 */
export const TaskService = {
  async create(tx: Executor, ctx: Ctx, input: TaskCreateInput): Promise<string> {
    const authorId = actorId(ctx)
    if (!authorId) throw errors.validation('У задачи должен быть автор')

    const project = input.projectId
      ? ((await projectInfo(tx, [input.projectId])).get(input.projectId) ?? null)
      : null
    if (input.projectId) {
      if (!project) throw errors.notFound('Проект')
      await authorize(ctx, 'create_task', input.projectId)
    }
    const sourceId = sourceObjectId(input.source)
    let source: ObjectLike | null = null
    if (sourceId) {
      await authorize(ctx, 'view', sourceId)
      source = await loadObject(sourceId, tx)
    }

    const kind = input.kind
    // У обычной задачи без исполнителя исполняет автор
    const assigneeId = input.assigneeId ?? (kind === 'task' ? authorId : null)
    const participants = {
      assigneeId,
      coAssignees: [...new Set(input.coAssigneeIds)].filter((id) => id !== assigneeId),
      controllerId: input.controllerId ?? null,
    }
    await assertPeople(participantsOf(participants))

    const spaceId = project?.spaceId ?? (await spaceFor(tx, ctx, input, source, authorId))
    const status = initialStatus(kind, project?.workflow)
    const key = await nextTaskKey(tx, { kind, project })
    const dueAt = input.dueAt ?? null
    const object = await ObjectService.create(tx, ctx, {
      type: 'task',
      spaceId,
      parentId: project?.id ?? null,
      title: input.title,
      subtitle: key,
      ownerId: authorId,
      // Поручение без проекта видят только участники
      accessMode: kind === 'instruction' && !project ? 'restricted' : 'inherit',
      meta: metaOf({ key, kind, status, priority: input.priority, dueAt, assigneeId }),
    })
    const storedSource =
      input.source?.kind === 'dataset_row'
        ? { ...input.source, label: input.source.label ?? null }
        : (input.source ?? null)
    await tx.insert(tasks).values({
      id: object.id,
      kind,
      key,
      projectId: project?.id ?? null,
      status,
      priority: input.priority,
      assigneeId,
      coAssignees: participants.coAssignees,
      authorId,
      controllerId: participants.controllerId,
      dueAt,
      description: input.description?.trim() || null,
      source: storedSource,
      labels: [...new Set(input.labels)],
      requiresAcceptance: kind === 'instruction',
      startedAt: kind === 'task' && status === 'in_progress' ? sql`now()` : null,
    })
    await syncParticipants(tx, ctx, object.id, object.ownerId, [], participantsOf(participants))
    if (sourceId && input.source) {
      await LinkService.link(
        tx,
        ctx,
        object.id,
        sourceId,
        'source',
        input.source.kind === 'dataset_row'
          ? { rowId: input.source.rowId, label: input.source.label ?? null }
          : {},
      )
    }

    const view = { id: object.id, spaceId, title: input.title }
    await emit(tx, ctx, view, 'task.created', { key, kind, assigneeId })
    if (assigneeId && assigneeId !== authorId) {
      await emit(tx, ctx, view, 'task.assigned', { key, assigneeId, previousAssigneeId: null })
    }
    if (kind === 'instruction') {
      await TaskInbox.assigned(tx, ctx, {
        id: object.id,
        authorId,
        assigneeId,
        controllerId: participants.controllerId,
        dueAt,
        priority: input.priority,
      })
    }
    await refreshViewers(tx, object.id)
    return object.id
  },

  async get(ctx: UserCtx, id: string): Promise<TaskRecord> {
    const decision = await authorize(ctx, 'view', id)
    const row = await loadRow(db(), id)
    if (!row) throw errors.notFound('Задача')
    const [people, projectMap] = await Promise.all([
      peopleOf([row]),
      projectInfo(db(), row.projectId ? [row.projectId] : []),
    ])
    const project = row.projectId ? projectMap.get(row.projectId) : null
    return recordOf(row, people, project, decision.level, actorOf(ctx))
  },

  /** Правка полей: у поручения — только автор, у задачи — кто правит. */
  async update(tx: Executor, ctx: Ctx, id: string, patch: TaskUpdateInput): Promise<void> {
    const decision = await authorize(ctx, 'edit', id)
    const row = await loadRow(tx, id, true)
    if (!row) throw errors.notFound('Задача')
    const projectMap = await projectInfo(tx, row.projectId ? [row.projectId] : [])
    const facts = factsOf(row, row.projectId ? projectMap.get(row.projectId) : null)
    const can = permissionsFor(facts, actorOf(ctx), decision.level)
    if (!can.edit) {
      throw isClosed(facts.status)
        ? errors.conflict('Задача закрыта — изменить её нельзя')
        : errors.forbidden('Изменять поручение может только его автор')
    }

    const instruction = row.kind === 'instruction'
    const assigneeId = patch.assigneeId === undefined ? row.assigneeId : patch.assigneeId
    if (instruction && !assigneeId) throw errors.validation('У поручения должен быть исполнитель')
    const dueAt = patch.dueAt === undefined ? row.dueAt : patch.dueAt
    if (instruction && !dueAt) throw errors.validation('У поручения должен быть срок')
    const coAssignees = [...new Set(patch.coAssigneeIds ?? row.coAssignees)].filter(
      (userId) => userId !== assigneeId,
    )
    const controllerId = patch.controllerId === undefined ? row.controllerId : patch.controllerId
    const after = { assigneeId, coAssignees, controllerId }
    const newcomers = participantsOf(after).filter(
      (userId) => !participantsOf(row).includes(userId),
    )
    await assertPeople(newcomers)

    const reassigned = assigneeId !== row.assigneeId
    const dueChanged = dueAt !== row.dueAt
    // Новый исполнитель поручения заново принимает его к исполнению
    const restart = instruction && reassigned
    await tx
      .update(tasks)
      .set({
        ...(patch.description !== undefined
          ? { description: patch.description?.trim() || null }
          : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.labels !== undefined ? { labels: [...new Set(patch.labels)] } : {}),
        assigneeId,
        coAssignees,
        controllerId,
        dueAt,
        ...(restart ? { status: 'assigned', startedAt: null } : {}),
      })
      .where(eq(tasks.id, id))

    const title = patch.title ?? row.title
    // Название — событие реестра (активность, поиск); остальное — события задачи
    if (patch.title !== undefined) await ObjectService.update(tx, ctx, id, { title: patch.title })
    await ObjectService.update(
      tx,
      ctx,
      id,
      {
        meta: metaOf({
          key: row.key,
          kind: row.kind,
          status: restart ? 'assigned' : row.status,
          priority: patch.priority ?? row.priority,
          dueAt,
          assigneeId,
        }),
        mergeMeta: true,
      },
      { silent: true },
    )
    await syncParticipants(tx, ctx, id, row.ownerId, participantsOf(row), participantsOf(after))

    const view = { id, spaceId: row.spaceId, title }
    if (reassigned && assigneeId) {
      await emit(tx, ctx, view, 'task.assigned', {
        key: row.key,
        assigneeId,
        previousAssigneeId: row.assigneeId,
      })
    }
    if (dueChanged) {
      await emit(tx, ctx, view, 'task.due_changed', { key: row.key, from: row.dueAt, to: dueAt })
    }
    if (restart) {
      if (row.status !== 'assigned') {
        await emit(tx, ctx, view, 'task.status_changed', {
          key: row.key,
          kind: row.kind,
          from: row.status,
          to: 'assigned',
        })
      }
      // Прежний исполнитель больше ничего не должен по этому поручению
      await TaskInbox.close(tx, ctx, id, {}, 'dismissed')
      await TaskInbox.assigned(tx, ctx, {
        id,
        authorId: row.authorId,
        assigneeId,
        controllerId,
        dueAt,
        priority: patch.priority ?? row.priority,
      })
    }
    await refreshViewers(tx, id)
  },

  /** Статус обычной задачи (доска): любой статус рабочего процесса, кроме текущего. */
  async setStatus(tx: Executor, ctx: Ctx, id: string, status: TaskStatus): Promise<void> {
    const decision = await authorize(ctx, 'edit', id)
    const row = await loadRow(tx, id, true)
    if (!row) throw errors.notFound('Задача')
    if (row.kind === 'instruction') {
      throw errors.validation(
        'Статус поручения меняют действия: принять, отчитаться, принять отчёт, вернуть',
      )
    }
    const projectMap = await projectInfo(tx, row.projectId ? [row.projectId] : [])
    const can = permissionsFor(
      factsOf(row, row.projectId ? projectMap.get(row.projectId) : null),
      actorOf(ctx),
      decision.level,
    )
    if (!can.transitions.includes(status)) {
      throw errors.conflict('Такой переход не предусмотрен рабочим процессом')
    }
    const from = row.status
    await tx
      .update(tasks)
      .set({
        status,
        completedAt: isClosed(status) ? sql`now()` : null,
        ...(status === 'in_progress' && !row.startedAt ? { startedAt: sql`now()` } : {}),
      })
      .where(eq(tasks.id, id))
    await ObjectService.update(tx, ctx, id, { meta: { status }, mergeMeta: true }, { silent: true })
    const view = { id, spaceId: row.spaceId, title: row.title }
    await emit(tx, ctx, view, 'task.status_changed', {
      key: row.key,
      kind: row.kind,
      from,
      to: status,
    })
    if (status === 'done') await emit(tx, ctx, view, 'task.completed', { key: row.key })
  },

  /** Исполнитель принимает поручение к исполнению. */
  async start(tx: Executor, ctx: Ctx, id: string): Promise<void> {
    const { row } = await instructionAction(tx, ctx, id, 'start')
    await tx
      .update(tasks)
      .set({ status: 'in_progress', startedAt: sql`coalesce(${tasks.startedAt}, now())` })
      .where(eq(tasks.id, id))
    await afterTransition(tx, ctx, row, 'in_progress')
    await emit(tx, ctx, viewOf(row), 'task.accepted', { key: row.key })
    await TaskInbox.close(tx, ctx, id, { kind: 'accept_instruction' })
    await TaskInbox.toReport(tx, ctx, inboxTaskOf(row))
  },

  /** Отчёт исполнителя: текст результата, приёмка — у автора и контролёра. */
  async report(tx: Executor, ctx: Ctx, id: string, input: TaskReportInput): Promise<void> {
    const { row } = await instructionAction(tx, ctx, id, 'report')
    await tx
      .update(tasks)
      .set({
        status: 'reported',
        reportedAt: sql`now()`,
        startedAt: sql`coalesce(${tasks.startedAt}, now())`,
        result: {
          text: input.text.trim(),
          reportedAt: new Date().toISOString(),
          reportedBy: actorId(ctx),
        },
      })
      .where(eq(tasks.id, id))
    await afterTransition(tx, ctx, row, 'reported')
    await emit(tx, ctx, viewOf(row), 'task.reported', { key: row.key })
    await TaskInbox.close(tx, ctx, id, { kind: 'accept_instruction' })
    await TaskInbox.close(tx, ctx, id, { kind: 'report_instruction' })
    await TaskInbox.reported(tx, ctx, inboxTaskOf(row))
  },

  /** Автор или контролёр принимает отчёт — поручение закрыто, Входящие по нему тоже. */
  async accept(tx: Executor, ctx: Ctx, id: string): Promise<void> {
    const { row } = await instructionAction(tx, ctx, id, 'accept')
    await tx
      .update(tasks)
      .set({ status: 'accepted', completedAt: sql`now()` })
      .where(eq(tasks.id, id))
    await afterTransition(tx, ctx, row, 'accepted')
    await emit(tx, ctx, viewOf(row), 'task.completed', { key: row.key })
    await TaskInbox.close(tx, ctx, id)
  },

  /** Возврат на доработку с замечаниями и, при необходимости, новым сроком. */
  async return(tx: Executor, ctx: Ctx, id: string, input: TaskReturnInput): Promise<void> {
    const { row } = await instructionAction(tx, ctx, id, 'return')
    const dueAt = input.dueAt ?? row.dueAt
    await tx
      .update(tasks)
      .set({ status: 'returned', returnComment: input.comment.trim(), dueAt })
      .where(eq(tasks.id, id))
    await afterTransition(tx, ctx, row, 'returned', { dueAt })
    const view = viewOf(row)
    await emit(tx, ctx, view, 'task.returned', { key: row.key, comment: input.comment.trim() })
    if (dueAt !== row.dueAt) {
      await emit(tx, ctx, view, 'task.due_changed', { key: row.key, from: row.dueAt, to: dueAt })
    }
    await TaskInbox.close(tx, ctx, id, { kind: 'accept_result' })
    await TaskInbox.toReport(tx, ctx, { ...inboxTaskOf(row), dueAt }, true)
  },

  /** Отмена: поручение — только автор; обычная задача — статусом «Отменена». */
  async cancel(tx: Executor, ctx: Ctx, id: string, input: TaskCancelInput): Promise<void> {
    const row = await loadRow(tx, id)
    if (!row) throw errors.notFound('Задача')
    if (row.kind !== 'instruction') {
      await TaskService.setStatus(tx, ctx, id, 'cancelled')
      return
    }
    await instructionAction(tx, ctx, id, 'cancel')
    await tx
      .update(tasks)
      .set({
        status: 'cancelled',
        completedAt: sql`now()`,
        ...(input.comment?.trim() ? { returnComment: input.comment.trim() } : {}),
      })
      .where(eq(tasks.id, id))
    await afterTransition(tx, ctx, row, 'cancelled')
    await TaskInbox.close(tx, ctx, id, {}, 'dismissed')
  },

  /**
   * Список: «мои» (исполняю или соисполняю), «поручил я», «на контроле» или
   * все доступные — всегда в пределах видимости ядра.
   */
  async list(
    ctx: UserCtx,
    query: TaskListQuery,
  ): Promise<{ items: TaskListItem[]; total: number }> {
    const me = ctx.onBehalfOf ?? ctx.userId
    const conditions: SQL[] = [sql`${objects.deletedAt} IS NULL`, visibleObjectsSql(ctx, 'task')]
    if (query.scope === 'mine') {
      conditions.push(sql`(${tasks.assigneeId} = ${me} OR ${me} = ANY(${tasks.coAssignees}))`)
    } else if (query.scope === 'assigned_by_me') {
      conditions.push(eq(tasks.authorId, me))
    } else if (query.scope === 'controlled') {
      conditions.push(eq(tasks.controllerId, me))
    }
    if (query.projectId) conditions.push(eq(tasks.projectId, query.projectId))
    if (query.kind) conditions.push(eq(tasks.kind, query.kind))
    if (query.state === 'open') conditions.push(notInArray(tasks.status, CLOSED))
    if (query.state === 'closed') conditions.push(inArray(tasks.status, CLOSED))
    const search = query.q?.trim()
    if (search) {
      const pattern = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
      conditions.push(sql`(${objects.title} ILIKE ${pattern} OR ${tasks.key} ILIKE ${pattern})`)
    }

    const where = and(...conditions)
    const [rows, counted] = await Promise.all([
      selectTasks(db())
        .where(where)
        .orderBy(sql`${tasks.dueAt} ASC NULLS LAST`, tasks.priority, desc(objects.createdAt))
        .limit(query.limit),
      db()
        .select({ count: sql<number>`count(*)::int` })
        .from(tasks)
        .innerJoin(objects, eq(objects.id, tasks.id))
        .where(where),
    ])
    const [people, projectMap] = await Promise.all([
      peopleOf(rows),
      projectInfo(db(), [
        ...new Set(rows.map((row) => row.projectId).filter((id): id is string => Boolean(id))),
      ]),
    ])
    const actor = actorOf(ctx)
    return {
      items: rows.map((row) =>
        listItemOf(
          row,
          people,
          row.projectId ? projectMap.get(row.projectId) : null,
          approximateLevel(ctx, row),
          actor,
        ),
      ),
      total: counted[0]?.count ?? 0,
    }
  },

  /** Задачи и поручения по строке датасета — для карточки строки. */
  async forRow(
    ctx: UserCtx,
    datasetId: string,
    rowId: string,
  ): Promise<{ items: TaskListItem[]; total: number }> {
    await authorize(ctx, 'view', datasetId)
    const where = and(
      sql`${objects.deletedAt} IS NULL`,
      visibleObjectsSql(ctx, 'task'),
      sql`${tasks.source}->>'datasetId' = ${datasetId}`,
      sql`${tasks.source}->>'rowId' = ${rowId}`,
    )
    const rows = await selectTasks(db()).where(where).orderBy(desc(objects.createdAt)).limit(50)
    const people = await peopleOf(rows)
    const actor = actorOf(ctx)
    return {
      items: rows.map((row) => listItemOf(row, people, null, approximateLevel(ctx, row), actor)),
      total: rows.length,
    }
  },

  /** Сводка «Мои задачи»: открытые, просроченные, на сегодня, ждут моей приёмки, в срок. */
  async summary(ctx: UserCtx): Promise<TaskSummary> {
    const me = ctx.onBehalfOf ?? ctx.userId
    const visible = and(sql`${objects.deletedAt} IS NULL`, visibleObjectsSql(ctx, 'task'))
    const mine = sql`(${tasks.assigneeId} = ${me} OR ${me} = ANY(${tasks.coAssignees}))`
    const open = sql`${mine} AND ${notInArray(tasks.status, CLOSED)}`
    const closedWithDue = sql`${mine} AND ${inArray(tasks.status, ['done', 'accepted'])}
      AND ${tasks.dueAt} IS NOT NULL AND ${tasks.completedAt} > now() - interval '90 days'`
    const zone = ctx.timezone
    const [row] = await db()
      .select({
        open: sql<number>`count(*) filter (where ${open})::int`,
        overdue: sql<number>`count(*) filter (where ${open} and ${tasks.dueAt} < now())::int`,
        dueToday: sql<number>`count(*) filter (where ${open}
          and (${tasks.dueAt} at time zone ${zone})::date = (now() at time zone ${zone})::date)::int`,
        toAccept: sql<number>`count(*) filter (where ${tasks.status} = 'reported'
          and (${tasks.authorId} = ${me} or ${tasks.controllerId} = ${me}))::int`,
        closedWithDue: sql<number>`count(*) filter (where ${closedWithDue})::int`,
        onTime: sql<number>`count(*) filter (where ${closedWithDue}
          and ${tasks.completedAt} <= ${tasks.dueAt})::int`,
      })
      .from(tasks)
      .innerJoin(objects, eq(objects.id, tasks.id))
      .where(visible)
    return {
      open: row?.open ?? 0,
      overdue: row?.overdue ?? 0,
      dueToday: row?.dueToday ?? 0,
      toAccept: row?.toAccept ?? 0,
      onTimeRate: row && row.closedWithDue > 0 ? row.onTime / row.closedWithDue : null,
    }
  },
}

function viewOf(row: TaskRow): { id: string; spaceId: string | null; title: string } {
  return { id: row.id, spaceId: row.spaceId, title: row.title }
}

function inboxTaskOf(row: TaskRow) {
  return {
    id: row.id,
    authorId: row.authorId,
    assigneeId: row.assigneeId,
    controllerId: row.controllerId,
    dueAt: row.dueAt,
    priority: row.priority,
  }
}

/**
 * Проверки действия поручения: объект виден (иначе 404), пользователь в нужной
 * роли (иначе 403), статус допускает действие (иначе 409 — поручение уже
 * в другом состоянии).
 */
async function instructionAction(
  tx: Executor,
  ctx: Ctx,
  id: string,
  action: InstructionAction,
): Promise<{ row: TaskRow }> {
  const decision = await authorize(ctx, 'view', id)
  const row = await loadRow(tx, id, true)
  if (!row) throw errors.notFound('Задача')
  if (row.kind !== 'instruction') throw errors.validation('Действие доступно только для поручения')
  const facts = factsOf(row, null)
  const can = permissionsFor(facts, actorOf(ctx), decision.level)
  if (can[action]) return { row }
  const allowedFrom = INSTRUCTION_ACTIONS[action].from as readonly TaskStatus[]
  if (!allowedFrom.includes(facts.status)) {
    throw errors.conflict('Поручение уже в другом состоянии — обновите карточку', {
      status: facts.status,
    })
  }
  throw errors.forbidden(
    action === 'start' || action === 'report'
      ? 'Это действие исполнителя поручения'
      : action === 'cancel'
        ? 'Отменить поручение может только автор'
        : 'Принять или вернуть отчёт может автор или контролёр',
  )
}

/** Общее после смены статуса поручения: состояние в реестре и событие перехода. */
async function afterTransition(
  tx: Executor,
  ctx: Ctx,
  row: TaskRow,
  to: TaskStatus,
  extra: { dueAt?: string | null } = {},
): Promise<void> {
  await ObjectService.update(
    tx,
    ctx,
    row.id,
    {
      meta: { status: to, ...(extra.dueAt !== undefined ? { dueAt: extra.dueAt } : {}) },
      mergeMeta: true,
    },
    { silent: true },
  )
  await emit(tx, ctx, viewOf(row), 'task.status_changed', {
    key: row.key,
    kind: row.kind,
    from: row.status,
    to,
  })
}
