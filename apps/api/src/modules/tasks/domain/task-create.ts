import type { TaskKind, TaskStatus } from '@kchs/contracts'
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { primaryUnitOf } from '~/kernel/access/principal-set.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { objects, type TaskSourceValue, tasks } from '~/shared/db/schema/index.js'
import { participantsOf, refreshViewers, syncParticipants } from './task-access.js'
import { CLOSED, emit, metaOf, type ProjectInfo } from './task-core.js'
import { type ResolvedDue, recordDueChange } from './task-due.js'
import { TaskInbox } from './task-inbox.js'
import { nextTaskKey } from './task-keys.js'
import { initialStatus } from './task-rules.js'

/** Всё, что нужно для записи задачи: ввод уже проверен и разрешён. */
export interface TaskSpec {
  kind: TaskKind
  title: string
  description: string | null
  project: ProjectInfo | null
  spaceId: string
  /** Родитель в реестре: проект или основное поручение (часть соисполнителя). */
  registryParentId: string | null
  accessMode: 'inherit' | 'restricted'
  authorId: string
  assigneeId: string | null
  coAssignees: string[]
  controllerId: string | null
  due: ResolvedDue | null
  priority: number
  labels: string[]
  source: TaskSourceValue | null
  /** Объект реестра источника — для связи `source`. */
  sourceObjectId: string | null
  territoryId: string | null
  /** Основное поручение, если это часть соисполнителя. */
  parentTaskId: string | null
}

/**
 * Запись задачи в транзакции создания (ADR-0060, ADR-0082): объект реестра,
 * строка задачи, права участников, связь с источником, история сроков, события
 * и Входящие исполнителя. Соисполнители поручения получают части «в части
 * касающейся» — поручения-потомки с контролем у ответственного исполнителя.
 */
export async function insertTask(tx: Executor, ctx: Ctx, spec: TaskSpec): Promise<string> {
  const status = initialStatus(spec.kind, spec.project?.workflow)
  const key = await nextTaskKey(tx, { kind: spec.kind, project: spec.project })
  const dueAt = spec.due?.dueAt ?? null
  const object = await ObjectService.create(tx, ctx, {
    type: 'task',
    spaceId: spec.spaceId,
    parentId: spec.registryParentId,
    title: spec.title,
    subtitle: key,
    ownerId: spec.authorId,
    accessMode: spec.accessMode,
    meta: metaOf({
      key,
      kind: spec.kind,
      status,
      priority: spec.priority,
      dueAt,
      assigneeId: spec.assigneeId,
    }),
  })
  const unitId = spec.assigneeId ? await primaryUnitOf(spec.assigneeId, tx) : null
  await tx.insert(tasks).values({
    id: object.id,
    kind: spec.kind,
    key,
    projectId: spec.project?.id ?? null,
    parentId: spec.parentTaskId,
    status,
    priority: spec.priority,
    assigneeId: spec.assigneeId,
    coAssignees: spec.coAssignees,
    authorId: spec.authorId,
    controllerId: spec.controllerId,
    dueAt,
    dueWorkingDays: spec.due?.workingDays ?? null,
    originalDueAt: dueAt,
    dueSetAt: sql`now()`,
    unitId,
    description: spec.description,
    source: spec.source,
    labels: spec.labels,
    territoryId: spec.territoryId,
    requiresAcceptance: spec.kind === 'instruction',
    startedAt: spec.kind === 'task' && status === 'in_progress' ? sql`now()` : null,
  })
  await syncParticipants(tx, ctx, object.id, object.ownerId, [], participantsOf(spec))
  if (spec.sourceObjectId && spec.source) {
    await LinkService.link(
      tx,
      ctx,
      object.id,
      spec.sourceObjectId,
      'source',
      spec.source.kind === 'dataset_row'
        ? { rowId: spec.source.rowId, label: spec.source.label ?? null }
        : spec.source.kind === 'resolution'
          ? { resolutionId: spec.source.resolutionId }
          : {},
    )
  }
  if (dueAt) {
    await recordDueChange(tx, ctx, {
      taskId: object.id,
      from: null,
      to: dueAt,
      workingDays: spec.due?.workingDays ?? null,
      reason: 'set',
    })
  }

  const view = { id: object.id, spaceId: spec.spaceId, title: spec.title }
  await emit(tx, ctx, view, 'task.created', {
    key,
    kind: spec.kind,
    assigneeId: spec.assigneeId,
  })
  if (spec.assigneeId && spec.assigneeId !== spec.authorId) {
    await emit(tx, ctx, view, 'task.assigned', {
      key,
      assigneeId: spec.assigneeId,
      previousAssigneeId: null,
    })
  }
  if (spec.kind === 'instruction') {
    await TaskInbox.assigned(tx, ctx, {
      id: object.id,
      authorId: spec.authorId,
      assigneeId: spec.assigneeId,
      controllerId: spec.controllerId,
      dueAt,
      priority: spec.priority,
      isPart: spec.parentTaskId !== null,
    })
  }
  await refreshViewers(tx, object.id)
  if (spec.kind === 'instruction' && !spec.parentTaskId && spec.coAssignees.length > 0) {
    await createParts(tx, ctx, { ...spec, id: object.id }, spec.coAssignees)
  }
  return object.id
}

/** Основное поручение, от которого создаются части соисполнителей. */
export type PartParent = TaskSpec & { id: string }

/**
 * Части соисполнителей (10-tasks-projects.md §4, ADR-0082): каждому — своё
 * поручение-потомок с тем же названием, сроком и источником; автор — автор
 * основного, контролёр — ответственный исполнитель (принимает их отчёты).
 * В реестре часть — дочерний объект основного поручения и наследует его права.
 */
export async function createParts(
  tx: Executor,
  ctx: Ctx,
  parent: PartParent,
  coAssignees: string[],
): Promise<string[]> {
  const ids: string[] = []
  for (const coAssignee of coAssignees) {
    if (coAssignee === parent.assigneeId) continue
    ids.push(
      await insertTask(tx, ctx, {
        ...parent,
        project: null,
        registryParentId: parent.id,
        accessMode: 'inherit',
        assigneeId: coAssignee,
        coAssignees: [],
        controllerId: parent.assigneeId,
        parentTaskId: parent.id,
      }),
    )
  }
  return ids
}

/** Открытые части основного поручения. */
export async function openParts(
  tx: Executor,
  parentId: string,
  assignees?: string[],
): Promise<Array<{ id: string; assigneeId: string | null; status: TaskStatus }>> {
  const conditions = [
    eq(tasks.parentId, parentId),
    notInArray(tasks.status, CLOSED),
    sql`${objects.deletedAt} IS NULL`,
  ]
  if (assignees) {
    if (assignees.length === 0) return []
    conditions.push(inArray(tasks.assigneeId, assignees))
  }
  const rows = await tx
    .select({ id: tasks.id, assigneeId: tasks.assigneeId, status: tasks.status })
    .from(tasks)
    .innerJoin(objects, eq(objects.id, tasks.id))
    .where(and(...conditions))
  return rows.map((row) => ({ ...row, status: row.status as TaskStatus }))
}
