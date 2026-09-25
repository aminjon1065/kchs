/**
 * Публичный API модуля «Задачи» для других модулей (01-overview.md §Как модули
 * взаимодействуют, 16-api-and-events.md §4): сводка задач по территориям
 * (паспорт территории, ADR-0077) и поручения по источнику — резолюции
 * документа, протоколу, объекту (ADR-0082). Права — у вызываемых служб:
 * источник должен быть виден `ctx`, видимость списков — предикат ядра.
 */
import {
  type Confidentiality,
  TaskCreateInput,
  type TaskListItem,
  type TaskPriority,
  TaskReassignInput,
  type TaskStatus,
  TaskUpdateInput,
} from '@kchs/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, tasks } from '~/shared/db/schema/index.js'
import { CLOSED } from './domain/task-core.js'
import { TaskService } from './domain/task-service.js'
import { type InstructionSourceStatus, sourceStatus } from './domain/task-source.js'

export type { InstructionSourceStatus }

export const TaskQueries = {
  /** Открытые, просроченные и закрытые задачи с территорией из списка. */
  territoryCounts: (
    ctx: Ctx,
    territoryIds: string[],
  ): Promise<{ open: number; overdue: number; closed: number }> =>
    TaskService.territoryCounts(ctx, territoryIds),
}

/** Источник поручения: резолюция документа или иной объект реестра. */
export type InstructionSource =
  | { kind: 'resolution'; objectId: string; resolutionId: string; label?: string | null }
  | { kind: 'object'; objectId: string }

/** Срок поручения: дата (конец дня) или «N рабочих дней» по производственному календарю. */
export type InstructionDue = { at: string } | { workingDays: number }

export interface InstructionInput {
  title: string
  description?: string | null
  source: InstructionSource
  /**
   * Автор поручения — например, автор резолюции, если её вносит помощник или
   * канцелярия; без него — пользователь `ctx`. Вызывающий модуль отвечает за
   * то, что пользователь вправе вносить поручение от имени автора.
   */
  authorId?: string
  assigneeId: string
  /** Соисполнители получают части «в части касающейся» с контролем у ответственного. */
  coAssigneeIds?: string[]
  controllerId?: string | null
  due: InstructionDue
  priority?: TaskPriority
  /** Пространство; по умолчанию — пространство источника. */
  spaceId?: string
  territoryId?: string
  /** Гриф поручения и частей — гриф источника (резолюция конфиденциального документа). */
  confidentiality?: Confidentiality
}

export interface CreatedInstruction {
  id: string
  key: string
  /** Части соисполнителей — в порядке `coAssigneeIds`. */
  parts: Array<{ id: string; key: string; assigneeId: string | null }>
}

/**
 * Поручения для документооборота и протоколов (08-documents.md §6, ADR-0082).
 *
 * - `create` — в транзакции вызывающего модуля: поручение, части соисполнителей,
 *   Входящие и уведомления исполнителей, история сроков, события `task.*`.
 * - `status` — открыты ли ещё поручения источника (с частями соисполнителей).
 * - Когда последнее поручение источника принято или отменено, в той же
 *   транзакции публикуется `task.source_closed` (объект события — источник,
 *   в полезной нагрузке — `sourceObjectId`, `resolutionIds`, итоги): подписчик
 *   модуля документов переводит документ в `executed`.
 */
export const Instructions = {
  async create(tx: Executor, ctx: Ctx, input: InstructionInput): Promise<CreatedInstruction> {
    const parsed = TaskCreateInput.parse({
      kind: 'instruction',
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      assigneeId: input.assigneeId,
      coAssigneeIds: input.coAssigneeIds ?? [],
      ...(input.controllerId ? { controllerId: input.controllerId } : {}),
      ...('at' in input.due ? { dueAt: input.due.at } : { dueWorkingDays: input.due.workingDays }),
      priority: input.priority ?? 3,
      source: input.source,
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      ...(input.territoryId ? { territoryId: input.territoryId } : {}),
    })
    const id = await TaskService.create(tx, ctx, parsed, {
      ...(input.authorId ? { authorId: input.authorId } : {}),
      ...(input.confidentiality ? { confidentiality: input.confidentiality } : {}),
    })
    const rows = await tx
      .select({
        id: tasks.id,
        key: tasks.key,
        parentId: tasks.parentId,
        assigneeId: tasks.assigneeId,
      })
      .from(tasks)
      .where(and(eq(tasks.kind, 'instruction'), eq(tasks.parentId, id)))
    const [main] = await tx.select({ key: tasks.key }).from(tasks).where(eq(tasks.id, id)).limit(1)
    const order = new Map((input.coAssigneeIds ?? []).map((userId, index) => [userId, index]))
    return {
      id,
      key: main?.key ?? '',
      parts: rows
        .map((row) => ({ id: row.id, key: row.key, assigneeId: row.assigneeId }))
        .sort(
          (a, b) => (order.get(a.assigneeId ?? '') ?? 0) - (order.get(b.assigneeId ?? '') ?? 0),
        ),
    }
  },

  /** Сколько поручений источника открыто и чем закрыты остальные («все закрыты?»). */
  status: (sourceObjectId: string, executor?: Executor): Promise<InstructionSourceStatus> =>
    sourceStatus(sourceObjectId, executor),

  /** Поручения источника, видимые `ctx`, — вкладка «Резолюции и поручения». */
  bySource: (ctx: Ctx, sourceObjectId: string): Promise<TaskListItem[]> =>
    TaskService.bySource(ctx, sourceObjectId),

  /**
   * Открытые поручения из списка (ещё не отчитаны): кому поручено и основное ли —
   * для готового отчёта после отправки ответа (N22, ADR-0136).
   */
  async open(
    ids: readonly string[],
    executor: Executor = db(),
  ): Promise<Array<{ id: string; parentId: string | null; assigneeId: string | null }>> {
    if (ids.length === 0) return []
    return executor
      .select({ id: tasks.id, parentId: tasks.parentId, assigneeId: tasks.assigneeId })
      .from(tasks)
      .innerJoin(objects, eq(objects.id, tasks.id))
      .where(
        and(
          inArray(tasks.id, [...ids]),
          inArray(tasks.status, ['assigned', 'in_progress']),
          sql`${objects.deletedAt} IS NULL`,
        ),
      )
  },

  /** Готовый отчёт исполнителю: отправляет его одной кнопкой (ADR-0136). */
  prepareReport: (
    tx: Executor,
    ctx: Ctx,
    taskId: string,
    draft: { text: string; objectIds: string[]; cause: 'reply_dispatched'; sourceObjectId: string },
  ): Promise<boolean> => TaskService.prepareReport(tx, ctx, taskId, draft),

  /**
   * Сколько поручений из списка (резолюции — основное и части) всего и сколько
   * ещё открыто — без содержания, в том числе невидимых смотрящему (ADR-0084).
   */
  async progress(
    ids: readonly string[],
    executor: Executor = db(),
  ): Promise<{ total: number; open: number }> {
    if (ids.length === 0) return { total: 0, open: 0 }
    const rows = await executor
      .select({ status: tasks.status })
      .from(tasks)
      .innerJoin(objects, eq(objects.id, tasks.id))
      .where(and(inArray(tasks.id, [...ids]), sql`${objects.deletedAt} IS NULL`))
    return {
      total: rows.length,
      open: rows.filter((row) => !(CLOSED as readonly string[]).includes(row.status)).length,
    }
  },
}

/**
 * Точечные действия над задачей для правил автоматизации (ADR-0096): смена
 * статуса, переназначение и контролёр. Права проверяет вызывающий —
 * `authorize` на объекте задачи; переходы статусов проверяет сама служба.
 * @public — правила автоматизации (действия `set_status`, `assign`)
 */
export const Tasks = {
  setStatus: (tx: Executor, ctx: Ctx, taskId: string, status: TaskStatus): Promise<void> =>
    TaskService.setStatus(tx, ctx, taskId, status),
  reassign: (tx: Executor, ctx: Ctx, taskId: string, input: TaskReassignInput): Promise<void> =>
    TaskService.reassign(tx, ctx, taskId, TaskReassignInput.parse(input)),
  setController: (tx: Executor, ctx: Ctx, taskId: string, userId: string): Promise<void> =>
    TaskService.update(tx, ctx, taskId, TaskUpdateInput.parse({ controllerId: userId })),
}
