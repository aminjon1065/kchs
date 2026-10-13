import { type TaskSource, type TaskStatus, taskSourceObjectId } from '@kchs/contracts'
import { eq, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { primaryUnitOf } from '~/kernel/access/principal-set.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { actorId, type Ctx } from '~/shared/context.js'
import type { Executor, Tx } from '~/shared/db/client.js'
import { AppError, errors } from '~/shared/errors.js'
import { tasks } from '../schema.js'
import { participantsOf, refreshViewers, syncParticipants } from './task-access.js'
import {
  actorOf,
  emit,
  factsOf,
  hasPendingExtension,
  loadRow,
  type TaskRow,
  viewOf,
} from './task-core.js'
import { createParts, openParts } from './task-create.js'
import { TaskExtensions } from './task-extensions.js'
import { TaskInbox } from './task-inbox.js'
import {
  INSTRUCTION_ACTIONS,
  INSTRUCTION_OPEN_STATUSES,
  type InstructionAction,
  permissionsFor,
} from './task-rules.js'
import { inboxTaskOf } from './task-views.js'

/**
 * Поручения (ADR-0082): допустимые действия по статусу, переходы с последствиями, смена
 * исполнителя, части соисполнителей и отмена всего поручения.
 */

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
export async function instructionAction(
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
export async function afterTransition(
  tx: Tx,
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
export async function assertPartsClosed(tx: Executor, row: TaskRow): Promise<void> {
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
export async function changeAssignee(
  tx: Tx,
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
  tx: Tx,
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
export async function syncParts(
  tx: Tx,
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
export async function cancelInstruction(
  tx: Tx,
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
