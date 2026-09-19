import {
  type Level,
  type TaskCancelInput,
  type TaskCreateInput,
  type TaskExtensionDecisionInput,
  type TaskExtensionRequestInput,
  type TaskKind,
  type TaskListItem,
  type TaskListQuery,
  type TaskPart,
  type TaskReassignInput,
  type TaskRecord,
  type TaskReportInput,
  type TaskResultObject,
  type TaskReturnInput,
  type TaskSource,
  type TaskStatus,
  type TaskSummary,
  type TaskUpdateInput,
  taskSourceObjectId,
  type UserRef,
} from '@kchs/contracts'
import { and, asc, desc, eq, inArray, isNull, notInArray, type SQL, sql } from 'drizzle-orm'
import { authorize, loadObject, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { primaryUnitOf } from '~/kernel/access/principal-set.js'
import type { ObjectLike } from '~/kernel/access/types.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { directory } from '~/kernel/directory/port.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { SpaceService } from '~/kernel/spaces/service.js'
import { DatasetQueries, datasetRecord } from '~/modules/data/public.js'
import { territoryIndex } from '~/modules/gis/public.js'
import { actorId, type Ctx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, type TaskSourceValue, tasks } from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import {
  approximateLevel,
  participantsOf,
  refreshViewers,
  syncParticipants,
} from './task-access.js'
import {
  actorOf,
  assertPeople,
  CLOSED,
  emit,
  factsOf,
  hasPendingExtension,
  loadRow,
  overdueSql,
  type ProjectInfo,
  projectInfo,
  refsOf,
  selectTasks,
  type TaskRow,
  viewOf,
} from './task-core.js'
import { createParts, insertTask, openParts, type TaskSpec } from './task-create.js'
import { applyDue, dueHistoryOf, resolveDue, sameMoment } from './task-due.js'
import { TaskExtensions } from './task-extensions.js'
import { type InboxTask, TaskInbox } from './task-inbox.js'
import {
  INSTRUCTION_ACTIONS,
  INSTRUCTION_OPEN_STATUSES,
  type InstructionAction,
  isClosed,
  isOverdue,
  permissionsFor,
  type TaskActor,
} from './task-rules.js'
import { closeSourceIfDone } from './task-source.js'

/** Ссылки на людей задачи одним запросом к справочнику. */
async function peopleOf(rows: TaskRow[]): Promise<Map<string, UserRef>> {
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

function listItemOf(
  row: TaskRow,
  people: Map<string, UserRef>,
  project: ProjectInfo | null | undefined,
  level: Level,
  actor: TaskActor,
  pendingExtension = false,
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
    dueWorkingDays: row.dueWorkingDays,
    originalDueAt: row.originalDueAt,
    extensions: row.extensions,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    labels: row.labels,
    territoryId: row.territoryId,
    overdue: isOverdue(status, row.dueAt, new Date(), row.reportedAt),
    parentId: row.parentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
    can: permissionsFor(factsOf(row, project, pendingExtension), actor, level),
  }
}

/** Участники — действующие сотрудники: проверка новых. */
function newcomers(before: TaskRow, after: Parameters<typeof participantsOf>[0]): string[] {
  const had = participantsOf(before)
  return participantsOf(after).filter((userId) => !had.includes(userId))
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

/** Территория задачи — единица справочника; неизвестная — ошибка поля. */
async function assertTerritory(id: string): Promise<string> {
  const index = await territoryIndex()
  if (!index.byId.has(id)) {
    throw errors.validation('Нет такой территории', [
      { path: 'territoryId', message: 'Нет такой территории' },
    ])
  }
  return id
}

/**
 * Территория строки-источника (ADR-0077): значение поля территории датасета,
 * прочитанное с политиками автора. Нет поля, строка скрыта или значение не из
 * справочника — задача без территории.
 */
async function territoryOfRow(ctx: Ctx, source: TaskSource | undefined): Promise<string | null> {
  if (source?.kind !== 'dataset_row') return null
  const dataset = await datasetRecord(source.datasetId)
  if (!dataset.territoryField) return null
  try {
    const row = await DatasetQueries.row(ctx, source.datasetId, source.rowId)
    const value = row.values[dataset.territoryField]
    if (typeof value !== 'string') return null
    return (await territoryIndex()).byId.has(value) ? value : null
  } catch (error) {
    if (error instanceof AppError && [403, 404].includes(error.status)) return null
    throw error
  }
}

/** Источник для хранения: подпись строки и резолюции — явным `null`, если её нет. */
function storedSource(source: TaskSource | undefined): TaskSourceValue | null {
  if (!source) return null
  if (source.kind === 'dataset_row') return { ...source, label: source.label ?? null }
  if (source.kind === 'resolution') return { ...source, label: source.label ?? null }
  return source
}

/** Лишние (не свои) права создателя: создаёт от имени автора только доверенный вызов модуля. */
export interface CreateOptions {
  /** Автор поручения, если создаёт не он сам (резолюция, протокол, правило, ADR-0082). */
  authorId?: string
}

/**
 * Задачи и поручения (10-tasks-projects.md, ADR-0060, ADR-0082): одна сущность,
 * разные правила. Создание — объект реестра, строка задачи, права участников,
 * связь с источником, история сроков, события и Входящие в одной транзакции.
 */
export const TaskService = {
  async create(
    tx: Executor,
    ctx: Ctx,
    input: TaskCreateInput,
    options: CreateOptions = {},
  ): Promise<string> {
    const authorId = options.authorId ?? actorId(ctx)
    if (!authorId) throw errors.validation('У задачи должен быть автор')

    const project = input.projectId
      ? ((await projectInfo(tx, [input.projectId])).get(input.projectId) ?? null)
      : null
    if (input.projectId) {
      if (!project) throw errors.notFound('Проект')
      await authorize(ctx, 'create_task', input.projectId)
    }
    const sourceId = taskSourceObjectId(input.source)
    let source: ObjectLike | null = null
    if (sourceId) {
      await authorize(ctx, 'view', sourceId)
      source = await loadObject(sourceId, tx)
    }

    const kind = input.kind
    // У обычной задачи без исполнителя исполняет автор
    const assigneeId = input.assigneeId ?? (kind === 'task' ? authorId : null)
    const coAssignees = [...new Set(input.coAssigneeIds)].filter((id) => id !== assigneeId)
    const controllerId = input.controllerId ?? null
    await assertPeople([
      ...new Set([authorId, ...participantsOf({ assigneeId, coAssignees, controllerId })]),
    ])

    const territoryId = input.territoryId
      ? await assertTerritory(input.territoryId)
      : await territoryOfRow(ctx, input.source)
    const spaceId = project?.spaceId ?? (await spaceFor(tx, ctx, input, source, authorId))
    const due = (await resolveDue(input, new Date(), tx)) ?? null
    const spec: TaskSpec = {
      kind,
      title: input.title,
      description: input.description?.trim() || null,
      project,
      spaceId,
      registryParentId: project?.id ?? null,
      // Поручение без проекта видят только участники (и руководители исполнителя)
      accessMode: kind === 'instruction' && !project ? 'restricted' : 'inherit',
      authorId,
      assigneeId,
      coAssignees,
      controllerId,
      due,
      priority: input.priority,
      labels: [...new Set(input.labels)],
      source: storedSource(input.source),
      sourceObjectId: sourceId,
      territoryId,
      parentTaskId: null,
    }
    return insertTask(tx, ctx, spec)
  },

  async get(ctx: UserCtx, id: string): Promise<TaskRecord> {
    const decision = await authorize(ctx, 'view', id)
    const row = await loadRow(db(), id)
    if (!row) throw errors.notFound('Задача')
    const [people, projectMap, pending, dueHistory, extension, parts, parent, resultObjects] =
      await Promise.all([
        peopleOf([row]),
        projectInfo(db(), row.projectId ? [row.projectId] : []),
        hasPendingExtension(db(), id),
        dueHistoryOf(id),
        TaskExtensions.latest(id),
        partsOf(ctx, row),
        parentOf(row),
        resultObjectsOf(ctx, row),
      ])
    const project = row.projectId ? projectMap.get(row.projectId) : null
    return {
      ...listItemOf(row, people, project, decision.level, actorOf(ctx), pending),
      description: row.description,
      coAssignees: row.coAssignees.flatMap((userId) => {
        const ref = people.get(userId)
        return ref ? [ref] : []
      }),
      controller: row.controllerId ? (people.get(row.controllerId) ?? null) : null,
      result: row.result
        ? {
            text: row.result.text,
            reportedAt: row.result.reportedAt,
            reportedBy: row.result.reportedBy ? (people.get(row.result.reportedBy) ?? null) : null,
            objects: resultObjects,
          }
        : null,
      returnComment: row.returnComment,
      source: (row.source as TaskSource | null) ?? null,
      parent,
      parts,
      dueHistory,
      extension,
    }
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
    const due = await resolveDue(patch, new Date(), tx)
    if (instruction && due && !due.dueAt) throw errors.validation('У поручения должен быть срок')
    const coAssignees = [...new Set(patch.coAssigneeIds ?? row.coAssignees)].filter(
      (userId) => userId !== assigneeId,
    )
    const controllerId = patch.controllerId === undefined ? row.controllerId : patch.controllerId
    const after = { assigneeId, coAssignees, controllerId }
    await assertPeople(newcomers(row, after))

    const reassigned = assigneeId !== row.assigneeId
    const territoryId =
      patch.territoryId === undefined
        ? row.territoryId
        : patch.territoryId === null
          ? null
          : await assertTerritory(patch.territoryId)
    await tx
      .update(tasks)
      .set({
        ...(patch.description !== undefined
          ? { description: patch.description?.trim() || null }
          : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.labels !== undefined ? { labels: [...new Set(patch.labels)] } : {}),
        coAssignees,
        controllerId,
        territoryId,
      })
      .where(eq(tasks.id, id))

    const title = patch.title ?? row.title
    // Название — событие реестра (активность, поиск); остальное — события задачи
    if (patch.title !== undefined) await ObjectService.update(tx, ctx, id, { title: patch.title })
    if (patch.priority !== undefined) {
      await ObjectService.update(
        tx,
        ctx,
        id,
        { meta: { priority: patch.priority }, mergeMeta: true },
        { silent: true },
      )
    }
    await syncParticipants(tx, ctx, id, row.ownerId, participantsOf(row), participantsOf(after))

    const view = { id, spaceId: row.spaceId, title }
    if (due) {
      await applyDue(tx, ctx, { ...view, key: row.key, dueAt: row.dueAt }, due, {
        reason: 'edit',
        comment: patch.dueComment ?? null,
      })
    }
    if (territoryId !== row.territoryId) {
      await emit(tx, ctx, view, 'task.territory_changed', {
        key: row.key,
        from: row.territoryId,
        to: territoryId,
      })
    }
    if (reassigned && assigneeId) {
      await changeAssignee(tx, ctx, { ...row, title, coAssignees, controllerId }, assigneeId, null)
    }
    if (instruction && !row.parentId && patch.coAssigneeIds !== undefined) {
      await syncParts(tx, ctx, row, coAssignees, title)
    }
    // Контролёр основного поручения не влияет на части: их контролирует исполнитель
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

  /** Исполнитель принимает поручение к исполнению — время принятия фиксируется. */
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

  /**
   * Отчёт исполнителя: текст, вложения и ссылки на объекты; приёмка — у автора и
   * контролёра (у части соисполнителя — у ответственного исполнителя). Пока
   * части соисполнителей открыты, ответственный не отчитывается: он собирает
   * их результаты (ADR-0082).
   */
  async report(tx: Executor, ctx: Ctx, id: string, input: TaskReportInput): Promise<void> {
    const { row } = await instructionAction(tx, ctx, id, 'report')
    await assertPartsClosed(tx, row)
    const objectIds = [...new Set(input.objectIds ?? [])].filter((objectId) => objectId !== id)
    for (const objectId of objectIds) await authorize(ctx, 'view', objectId)
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
          objectIds,
        },
      })
      .where(eq(tasks.id, id))
    // Подготовленные объекты — связи отчёта; вложения поручения уже связаны с ним
    for (const objectId of objectIds) {
      await LinkService.link(tx, ctx, id, objectId, 'related', { report: true })
    }
    await afterTransition(tx, ctx, row, 'reported')
    await emit(tx, ctx, viewOf(row), 'task.reported', { key: row.key })
    // Отчитался — просить продления больше незачем
    await TaskExtensions.cancelPending(tx, ctx, id)
    await TaskInbox.close(tx, ctx, id, { kind: 'accept_instruction' })
    await TaskInbox.close(tx, ctx, id, { kind: 'report_instruction' })
    await TaskInbox.reported(tx, ctx, inboxTaskOf(row))
  },

  /** Автор или контролёр принимает отчёт — поручение закрыто, Входящие по нему тоже. */
  async accept(tx: Executor, ctx: Ctx, id: string): Promise<void> {
    const { row } = await instructionAction(tx, ctx, id, 'accept')
    await assertPartsClosed(tx, row)
    await tx
      .update(tasks)
      .set({ status: 'accepted', completedAt: sql`now()` })
      .where(eq(tasks.id, id))
    await afterTransition(tx, ctx, row, 'accepted')
    await emit(tx, ctx, viewOf(row), 'task.completed', { key: row.key })
    await TaskInbox.close(tx, ctx, id)
    await closeSourceIfDone(tx, ctx, row.source)
  },

  /** Возврат на доработку с замечаниями и, при необходимости, новым сроком. */
  async return(tx: Executor, ctx: Ctx, id: string, input: TaskReturnInput): Promise<void> {
    const { row } = await instructionAction(tx, ctx, id, 'return')
    const due = await resolveDue(input, new Date(), tx)
    await tx
      .update(tasks)
      .set({ status: 'returned', returnComment: input.comment.trim() })
      .where(eq(tasks.id, id))
    await afterTransition(tx, ctx, row, 'returned')
    const view = viewOf(row)
    await emit(tx, ctx, view, 'task.returned', { key: row.key, comment: input.comment.trim() })
    await TaskInbox.close(tx, ctx, id, { kind: 'accept_result' })
    let dueAt = row.dueAt
    if (due?.dueAt && !sameMoment(due.dueAt, row.dueAt)) {
      await applyDue(tx, ctx, { ...view, key: row.key, dueAt: row.dueAt }, due, {
        reason: 'return',
        comment: input.comment.trim(),
      })
      dueAt = due.dueAt
    }
    await TaskInbox.toReport(tx, ctx, { ...inboxTaskOf(row), dueAt }, true)
  },

  /**
   * Отмена: поручение — только автор, вместе с открытыми частями соисполнителей;
   * обычная задача — статусом «Отменена».
   */
  async cancel(tx: Executor, ctx: Ctx, id: string, input: TaskCancelInput): Promise<void> {
    const row = await loadRow(tx, id)
    if (!row) throw errors.notFound('Задача')
    if (row.kind !== 'instruction') {
      await TaskService.setStatus(tx, ctx, id, 'cancelled')
      return
    }
    await instructionAction(tx, ctx, id, 'cancel')
    await cancelInstruction(tx, ctx, row, input.comment?.trim() || null)
    await closeSourceIfDone(tx, ctx, row.source)
  },

  /**
   * Переназначение исполнителя автором или контролёром (10-tasks-projects.md
   * §4): новый исполнитель заново принимает поручение, прежний теряет права и
   * дела, контроль частей соисполнителей переходит к новому исполнителю.
   */
  async reassign(tx: Executor, ctx: Ctx, id: string, input: TaskReassignInput): Promise<void> {
    const { row } = await instructionAction(tx, ctx, id, 'reassign')
    if (input.assigneeId === row.assigneeId) {
      throw errors.validation('Сотрудник уже исполняет это поручение')
    }
    if (row.coAssignees.includes(input.assigneeId)) {
      throw errors.validation(
        'Сотрудник — соисполнитель: сначала исключите его из соисполнителей',
        [{ path: 'assigneeId', message: 'Сотрудник — соисполнитель' }],
      )
    }
    await assertPeople([input.assigneeId])
    const after = { ...row, assigneeId: input.assigneeId }
    await syncParticipants(tx, ctx, id, row.ownerId, participantsOf(row), participantsOf(after))
    await changeAssignee(tx, ctx, row, input.assigneeId, input.comment?.trim() || null)
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.taskReassigned,
        objectId: id,
        objectType: 'task',
        details: {
          key: row.key,
          from: row.assigneeId,
          to: input.assigneeId,
          comment: input.comment?.trim() || null,
        },
      },
      tx,
    )
    await refreshViewers(tx, id)
  },

  /** Исполнитель просит продлить срок: решение — за автором (ADR-0082). */
  async requestExtension(
    tx: Executor,
    ctx: Ctx,
    id: string,
    input: TaskExtensionRequestInput,
  ): Promise<string> {
    const { row } = await instructionAction(tx, ctx, id, 'requestExtension')
    return TaskExtensions.request(tx, ctx, row, input)
  },

  /** Автор согласует продление (запрошенный или другой срок) или отказывает. */
  async decideExtension(
    tx: Executor,
    ctx: Ctx,
    id: string,
    input: TaskExtensionDecisionInput,
  ): Promise<void> {
    const { row } = await instructionAction(tx, ctx, id, 'decideExtension')
    await TaskExtensions.decide(tx, ctx, row, input)
  },

  /**
   * Список: «мои» (исполняю, у задачи — и соисполняю), «поручил я» (основные
   * поручения и задачи), «на контроле», «команда» (исполняют подчинённые) или
   * все доступные — всегда в пределах видимости ядра.
   */
  async list(
    ctx: UserCtx,
    query: TaskListQuery,
  ): Promise<{ items: TaskListItem[]; total: number }> {
    const me = ctx.onBehalfOf ?? ctx.userId
    const conditions: SQL[] = [sql`${objects.deletedAt} IS NULL`, visibleObjectsSql(ctx, 'task')]
    if (query.scope === 'mine') {
      conditions.push(mineSql(me))
    } else if (query.scope === 'assigned_by_me') {
      conditions.push(eq(tasks.authorId, me), isNull(tasks.parentId))
    } else if (query.scope === 'controlled') {
      conditions.push(eq(tasks.controllerId, me))
    } else if (query.scope === 'team') {
      const team = await directory().subordinates(me)
      if (team.length === 0) return { items: [], total: 0 }
      conditions.push(inArray(tasks.assigneeId, team))
    }
    if (query.projectId) conditions.push(eq(tasks.projectId, query.projectId))
    if (query.territoryId) {
      // Территория с вложенными: поручения района видны и в паспорте региона
      const ids = (await territoryIndex()).descendants(query.territoryId)
      conditions.push(inArray(tasks.territoryId, ids))
    }
    if (query.kind) conditions.push(eq(tasks.kind, query.kind))
    if (query.assigneeId) conditions.push(eq(tasks.assigneeId, query.assigneeId))
    if (query.state === 'open') conditions.push(notInArray(tasks.status, CLOSED))
    if (query.state === 'closed') conditions.push(inArray(tasks.status, CLOSED))
    const zone = ctx.timezone
    const localDue = sql`(${tasks.dueAt} at time zone ${zone})::date`
    if (query.dueFrom) conditions.push(sql`${localDue} >= ${query.dueFrom}::date`)
    if (query.dueTo) conditions.push(sql`${localDue} <= ${query.dueTo}::date`)
    if (query.overdue) conditions.push(overdueSql())
    if (query.noDue) conditions.push(isNull(tasks.dueAt))
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
    return { items: await listItems(ctx, rows), total: counted[0]?.count ?? 0 }
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
    const items = await listItems(ctx, rows)
    return { items, total: items.length }
  },

  /** Поручения по источнику (документу, объекту), видимые смотрящему — «Резолюции и поручения». */
  async bySource(ctx: Ctx, sourceObjectId: string): Promise<TaskListItem[]> {
    const rows = await selectTasks(db())
      .where(
        and(
          sql`${objects.deletedAt} IS NULL`,
          visibleObjectsSql(ctx, 'task'),
          sql`${tasks.source}->>'objectId' = ${sourceObjectId}`,
        ),
      )
      .orderBy(asc(objects.createdAt))
      .limit(500)
    return listItems(ctx, rows)
  },

  /**
   * Задачи и поручения территорий (паспорт территории, ADR-0077): открытые,
   * просроченные и закрытые — среди видимых смотрящему.
   */
  async territoryCounts(
    ctx: Ctx,
    territoryIds: string[],
  ): Promise<{ open: number; overdue: number; closed: number }> {
    if (territoryIds.length === 0) return { open: 0, overdue: 0, closed: 0 }
    const open = notInArray(tasks.status, CLOSED)
    const [row] = await db()
      .select({
        open: sql<number>`count(*) filter (where ${open})::int`,
        overdue: sql<number>`count(*) filter (where ${overdueSql()})::int`,
        closed: sql<number>`count(*) filter (where ${inArray(tasks.status, CLOSED)})::int`,
      })
      .from(tasks)
      .innerJoin(objects, eq(objects.id, tasks.id))
      .where(
        and(
          sql`${objects.deletedAt} IS NULL`,
          visibleObjectsSql(ctx, 'task'),
          inArray(tasks.territoryId, territoryIds),
        ),
      )
    return { open: row?.open ?? 0, overdue: row?.overdue ?? 0, closed: row?.closed ?? 0 }
  },

  /**
   * Сроки для календаря (проекция `tasks.due`, ADR-0081): задачи и поручения,
   * где я исполнитель, соисполнитель, автор или контролёр, со сроком в
   * диапазоне — среди видимых мне.
   */
  async dueBetween(ctx: UserCtx, from: Date, to: Date): Promise<TaskRow[]> {
    const me = ctx.onBehalfOf ?? ctx.userId
    return selectTasks(db())
      .where(
        and(
          sql`${objects.deletedAt} IS NULL`,
          visibleObjectsSql(ctx, 'task'),
          sql`(${tasks.assigneeId} = ${me} OR ${me} = ANY(${tasks.coAssignees})
            OR ${tasks.authorId} = ${me} OR ${tasks.controllerId} = ${me})`,
          sql`${tasks.dueAt} >= ${from.toISOString()} AND ${tasks.dueAt} < ${to.toISOString()}`,
        ),
      )
      .orderBy(tasks.dueAt)
      .limit(500)
  },

  /** Сводка «Мои задачи»: открытые, просроченные, на сегодня, ждут моей приёмки, в срок. */
  async summary(ctx: UserCtx): Promise<TaskSummary> {
    const me = ctx.onBehalfOf ?? ctx.userId
    const visible = and(sql`${objects.deletedAt} IS NULL`, visibleObjectsSql(ctx, 'task'))
    const mine = mineSql(me)
    const open = sql`${mine} AND ${notInArray(tasks.status, CLOSED)}`
    const closedWithDue = sql`${mine} AND ${inArray(tasks.status, ['done', 'accepted'])}
      AND ${tasks.dueAt} IS NOT NULL AND ${tasks.completedAt} > now() - interval '90 days'`
    const zone = ctx.timezone
    const [row] = await db()
      .select({
        open: sql<number>`count(*) filter (where ${open})::int`,
        overdue: sql<number>`count(*) filter (where ${mine} and ${overdueSql()})::int`,
        dueToday: sql<number>`count(*) filter (where ${open}
          and (${tasks.dueAt} at time zone ${zone})::date = (now() at time zone ${zone})::date)::int`,
        toAccept: sql<number>`count(*) filter (where ${tasks.status} = 'reported'
          and (${tasks.authorId} = ${me} or ${tasks.controllerId} = ${me}))::int`,
        closedWithDue: sql<number>`count(*) filter (where ${closedWithDue})::int`,
        onTime: sql<number>`count(*) filter (where ${closedWithDue}
          and coalesce(${tasks.reportedAt}, ${tasks.completedAt}) <= ${tasks.dueAt})::int`,
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

/**
 * «Мои»: исполняю; у обычной задачи — и соисполняю. Соисполнитель поручения
 * исполняет свою часть — она и есть его поручение (ADR-0082).
 */
function mineSql(me: string): SQL {
  return sql`(${tasks.assigneeId} = ${me}
    OR (${tasks.kind} <> 'instruction' AND ${me} = ANY(${tasks.coAssignees})))`
}

/** Строки списка с правами смотрящего (оценка для кнопок) и ожидающими продлениями. */
export async function listItems(ctx: Ctx, rows: TaskRow[]): Promise<TaskListItem[]> {
  if (rows.length === 0) return []
  const [people, projectMap, pending] = await Promise.all([
    peopleOf(rows),
    projectInfo(db(), [
      ...new Set(rows.map((row) => row.projectId).filter((id): id is string => Boolean(id))),
    ]),
    pendingExtensions(rows.map((row) => row.id)),
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

function inboxTaskOf(row: TaskRow): InboxTask {
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

/** Действия поручения: переходы статусов и действия без смены статуса. */
type GuardedAction = InstructionAction | 'reassign' | 'requestExtension' | 'decideExtension'

const FORBIDDEN_MESSAGE: Record<GuardedAction, string> = {
  start: 'Это действие исполнителя поручения',
  report: 'Это действие исполнителя поручения',
  accept: 'Принять или вернуть отчёт может автор или контролёр',
  return: 'Принять или вернуть отчёт может автор или контролёр',
  cancel: 'Отменить поручение может только автор',
  reassign: 'Переназначить исполнителя может автор или контролёр',
  requestExtension: 'Продление запрашивает исполнитель поручения',
  decideExtension: 'Решение о продлении принимает автор поручения',
}

/** Статусы, в которых действие вообще возможно (иначе — 409). */
function allowedStatuses(action: GuardedAction): readonly TaskStatus[] {
  if (action === 'reassign' || action === 'requestExtension' || action === 'decideExtension') {
    return INSTRUCTION_OPEN_STATUSES
  }
  return INSTRUCTION_ACTIONS[action].from as readonly TaskStatus[]
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
  action: GuardedAction,
): Promise<{ row: TaskRow }> {
  const decision = await authorize(ctx, 'view', id)
  const row = await loadRow(tx, id, true)
  if (!row) throw errors.notFound('Задача')
  if (row.kind !== 'instruction') throw errors.validation('Действие доступно только для поручения')
  const pending = await hasPendingExtension(tx, id)
  const facts = factsOf(row, null, pending)
  const can = permissionsFor(facts, actorOf(ctx), decision.level)
  if (can[action]) return { row }
  if (!allowedStatuses(action).includes(facts.status)) {
    throw errors.conflict('Поручение уже в другом состоянии — обновите карточку', {
      status: facts.status,
    })
  }
  if (action === 'requestExtension' && pending) {
    throw errors.conflict('Запрос продления уже ждёт решения автора')
  }
  if (action === 'decideExtension' && !pending) {
    throw errors.conflict('Запроса продления, ждущего решения, нет')
  }
  throw errors.forbidden(FORBIDDEN_MESSAGE[action])
}

/** Общее после смены статуса поручения: состояние в реестре и событие перехода. */
async function afterTransition(
  tx: Executor,
  ctx: Ctx,
  row: TaskRow,
  to: TaskStatus,
): Promise<void> {
  await ObjectService.update(
    tx,
    ctx,
    row.id,
    { meta: { status: to }, mergeMeta: true },
    { silent: true },
  )
  await emit(tx, ctx, viewOf(row), 'task.status_changed', {
    key: row.key,
    kind: row.kind,
    from: row.status,
    to,
  })
}

/** Ответственный отчитывается и поручение принимается, когда части соисполнителей закрыты. */
async function assertPartsClosed(tx: Executor, row: TaskRow): Promise<void> {
  if (row.parentId) return
  const open = await openParts(tx, row.id)
  if (open.length > 0) {
    throw new AppError(
      'conflict',
      `Сначала закройте части соисполнителей: открыто ${open.length}`,
      409,
      { data: { openParts: open.length } },
    )
  }
}

/**
 * Новый исполнитель поручения: статус «Назначено», подразделение исполнителя,
 * события, дела во Входящих; ожидавший решения запрос продления снимается;
 * контроль открытых частей соисполнителей переходит к новому исполнителю.
 * Права участников выдаёт вызывающий одним пересчётом.
 */
async function changeAssignee(
  tx: Executor,
  ctx: Ctx,
  row: TaskRow,
  assigneeId: string,
  comment: string | null,
): Promise<void> {
  const unitId = await primaryUnitOf(assigneeId, tx)
  await tx
    .update(tasks)
    .set({ assigneeId, status: 'assigned', startedAt: null, unitId })
    .where(eq(tasks.id, row.id))
  await ObjectService.update(
    tx,
    ctx,
    row.id,
    { meta: { assigneeId, status: 'assigned' }, mergeMeta: true },
    { silent: true },
  )
  const view = viewOf(row)
  await emit(tx, ctx, view, 'task.assigned', {
    key: row.key,
    assigneeId,
    previousAssigneeId: row.assigneeId,
    comment,
  })
  if (row.status !== 'assigned') {
    await emit(tx, ctx, view, 'task.status_changed', {
      key: row.key,
      kind: row.kind,
      from: row.status,
      to: 'assigned',
    })
  }
  await TaskExtensions.cancelPending(tx, ctx, row.id)
  // Прежний исполнитель больше ничего не должен по этому поручению
  await TaskInbox.close(tx, ctx, row.id, {}, 'dismissed')
  await TaskInbox.assigned(tx, ctx, { ...inboxTaskOf(row), assigneeId })
  if (!row.parentId) await retargetParts(tx, ctx, row.id, row.assigneeId, assigneeId)
}

/** Контроль открытых частей соисполнителей — у нового ответственного исполнителя. */
async function retargetParts(
  tx: Executor,
  ctx: Ctx,
  parentId: string,
  previous: string | null,
  next: string,
): Promise<void> {
  for (const part of await openParts(tx, parentId)) {
    const row = await loadRow(tx, part.id, true)
    if (!row || row.controllerId === next) continue
    const after = { ...row, controllerId: next }
    await tx.update(tasks).set({ controllerId: next }).where(eq(tasks.id, row.id))
    await syncParticipants(tx, ctx, row.id, row.ownerId, participantsOf(row), participantsOf(after))
    if (previous)
      await TaskInbox.close(tx, ctx, row.id, { kind: 'accept_result', userId: previous })
    if (row.status === 'reported') await TaskInbox.reported(tx, ctx, inboxTaskOf(after))
    await refreshViewers(tx, row.id)
  }
}

/**
 * Соисполнители основного поручения изменились: новые получают части, у
 * исключённых открытые части отменяются.
 */
async function syncParts(
  tx: Executor,
  ctx: Ctx,
  row: TaskRow,
  coAssignees: string[],
  title: string,
): Promise<void> {
  const removed = row.coAssignees.filter((userId) => !coAssignees.includes(userId))
  for (const part of await openParts(tx, row.id, removed)) {
    const partRow = await loadRow(tx, part.id, true)
    if (partRow) await cancelInstruction(tx, ctx, partRow, 'Соисполнитель исключён')
  }
  const added = coAssignees.filter((userId) => !row.coAssignees.includes(userId))
  if (added.length === 0) return
  const fresh = await loadRow(tx, row.id)
  if (!fresh) return
  await createParts(
    tx,
    ctx,
    {
      id: row.id,
      kind: 'instruction',
      title,
      description: fresh.description,
      project: null,
      spaceId: fresh.spaceId ?? '',
      registryParentId: row.id,
      accessMode: 'inherit',
      authorId: fresh.authorId ?? actorId(ctx) ?? '',
      assigneeId: fresh.assigneeId,
      coAssignees: [],
      controllerId: fresh.assigneeId,
      due: fresh.dueAt ? { dueAt: fresh.dueAt, workingDays: fresh.dueWorkingDays } : null,
      priority: fresh.priority,
      labels: fresh.labels,
      source: fresh.source,
      sourceObjectId: taskSourceObjectId(fresh.source as TaskSource | null),
      territoryId: fresh.territoryId,
      parentTaskId: row.id,
    },
    added,
  )
}

/** Отмена поручения и его открытых частей: статус, дела, запрос продления. */
async function cancelInstruction(
  tx: Executor,
  ctx: Ctx,
  row: TaskRow,
  comment: string | null,
): Promise<void> {
  await tx
    .update(tasks)
    .set({
      status: 'cancelled',
      completedAt: sql`now()`,
      ...(comment ? { returnComment: comment } : {}),
    })
    .where(eq(tasks.id, row.id))
  await afterTransition(tx, ctx, row, 'cancelled')
  await TaskExtensions.cancelPending(tx, ctx, row.id)
  await TaskInbox.close(tx, ctx, row.id, {}, 'dismissed')
  if (row.parentId) return
  for (const part of await openParts(tx, row.id)) {
    const partRow = await loadRow(tx, part.id, true)
    if (partRow) await cancelInstruction(tx, ctx, partRow, comment)
  }
}

/** Части соисполнителей основного поручения, видимые смотрящему. */
async function partsOf(ctx: UserCtx, row: TaskRow): Promise<TaskPart[]> {
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

async function parentOf(row: TaskRow): Promise<TaskRecord['parent']> {
  if (!row.parentId) return null
  const parent = await loadRow(db(), row.parentId)
  return parent ? { id: parent.id, key: parent.key, title: parent.title } : null
}

/**
 * Объекты отчёта: вложения и связанные объекты с названием, если смотрящий их
 * видит, иначе — «нет доступа» без названия.
 */
async function resultObjectsOf(ctx: UserCtx, row: TaskRow): Promise<TaskResultObject[]> {
  const ids = row.result?.objectIds ?? []
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
