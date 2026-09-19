import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { BigIntString, Timestamp, Uuid } from '../common/primitives.js'

/**
 * Задачи и поручения — одна сущность с разными правилами
 * (10-tasks-projects.md §1, ADR-0060). `task` — обычная задача с гибкими
 * статусами; `instruction` — поручение: автор, ответственный исполнитель,
 * контролёр, срок, обязательная приёмка, закрыть может только автор.
 */
export const TASK_KINDS = ['task', 'instruction', 'subtask', 'milestone'] as const
export const TaskKind = z.enum(TASK_KINDS)
export type TaskKind = z.infer<typeof TaskKind>

/** Виды, которые создаются в фазе 1 (подзадачи и вехи — с проектами и Гантом). */
export const CREATABLE_TASK_KINDS = ['task', 'instruction'] as const

/**
 * Статусы: рабочий процесс задачи по умолчанию `todo → in_progress → review → done`
 * и фиксированный процесс поручения `assigned → in_progress → reported →
 * accepted | returned`; `cancelled` — у обоих.
 */
export const TASK_STATUSES = [
  'todo',
  'assigned',
  'in_progress',
  'returned',
  'review',
  'reported',
  'done',
  'accepted',
  'cancelled',
] as const
export const TaskStatus = z.enum(TASK_STATUSES)
export type TaskStatus = z.infer<typeof TaskStatus>

/** Категории статусов — колонки общей доски задач и поручений. */
export const TASK_STATUS_CATEGORIES = [
  'todo',
  'in_progress',
  'review',
  'done',
  'cancelled',
] as const
export type TaskStatusCategory = (typeof TASK_STATUS_CATEGORIES)[number]

export const TASK_STATUS_CATEGORY: Record<TaskStatus, TaskStatusCategory> = {
  todo: 'todo',
  assigned: 'todo',
  in_progress: 'in_progress',
  returned: 'in_progress',
  review: 'review',
  reported: 'review',
  done: 'done',
  accepted: 'done',
  cancelled: 'cancelled',
}

/** Рабочий процесс задачи по умолчанию (проект может сузить его позже). */
export const DEFAULT_TASK_WORKFLOW: TaskStatus[] = [
  'todo',
  'in_progress',
  'review',
  'done',
  'cancelled',
]

/** Процесс поручения фиксирован (10-tasks-projects.md §2). */
export const INSTRUCTION_WORKFLOW: TaskStatus[] = [
  'assigned',
  'in_progress',
  'returned',
  'reported',
  'accepted',
  'cancelled',
]

/** Закрытые статусы: срок больше не отслеживается. */
export const CLOSED_TASK_STATUSES: readonly TaskStatus[] = ['done', 'accepted', 'cancelled']

/** Приоритет P1 (высший) … P4. */
export const TaskPriority = z.number().int().min(1).max(4)
export type TaskPriority = z.infer<typeof TaskPriority>

/** Откуда задача: строка датасета или другой объект реестра. */
export const TaskSource = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('dataset_row'),
    datasetId: Uuid,
    rowId: BigIntString,
    /** Подпись строки на момент создания («INC-0001 · Хатлон»). */
    label: z.string().trim().max(300).nullish(),
  }),
  z.object({ kind: z.literal('object'), objectId: Uuid }),
])
export type TaskSource = z.infer<typeof TaskSource>

/** Что пользователь может сделать с задачей — кнопки карточки и перенос на доске. */
export const TaskPermissions = z.object({
  /** Название, описание, приоритет, срок, исполнители. */
  edit: z.boolean(),
  /** Принять поручение к исполнению (исполнитель). */
  start: z.boolean(),
  /** Отчитаться об исполнении (исполнитель). */
  report: z.boolean(),
  /** Принять отчёт и закрыть поручение (автор или контролёр). */
  accept: z.boolean(),
  /** Вернуть на доработку (автор или контролёр). */
  return: z.boolean(),
  cancel: z.boolean(),
  /** Статусы, в которые можно перевести задачу одним действием (доска). */
  transitions: z.array(TaskStatus),
})
export type TaskPermissions = z.infer<typeof TaskPermissions>

export const TaskProjectRef = z.object({ id: Uuid, key: z.string(), name: z.string() })
export type TaskProjectRef = z.infer<typeof TaskProjectRef>

export const TaskResult = z.object({
  text: z.string(),
  reportedAt: Timestamp,
  reportedBy: UserRef.nullable(),
})
export type TaskResult = z.infer<typeof TaskResult>

export const TaskRecord = z.object({
  id: Uuid,
  key: z.string(),
  kind: TaskKind,
  title: z.string(),
  description: z.string().nullable(),
  status: TaskStatus,
  priority: TaskPriority,
  author: UserRef.nullable(),
  assignee: UserRef.nullable(),
  coAssignees: z.array(UserRef),
  controller: UserRef.nullable(),
  project: TaskProjectRef.nullable(),
  spaceId: Uuid.nullable(),
  dueAt: Timestamp.nullable(),
  /** Исполнитель принял поручение к исполнению (или начал задачу). */
  startedAt: Timestamp.nullable(),
  completedAt: Timestamp.nullable(),
  result: TaskResult.nullable(),
  /** Замечания при последнем возврате на доработку. */
  returnComment: z.string().nullable(),
  source: TaskSource.nullable(),
  labels: z.array(z.string()),
  /**
   * Территория, к которой относится задача (паспорт территории, ADR-0077); из
   * строки датасета — значение её поля территории.
   */
  territoryId: Uuid.nullable(),
  /** Срок прошёл, а задача не закрыта. */
  overdue: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  version: z.number().int(),
  can: TaskPermissions,
})
export type TaskRecord = z.infer<typeof TaskRecord>

/** Строка списка и карточка доски. */
export const TaskListItem = TaskRecord.omit({
  description: true,
  result: true,
  returnComment: true,
  coAssignees: true,
  controller: true,
  source: true,
})
export type TaskListItem = z.infer<typeof TaskListItem>

const Title = z.string().trim().min(1).max(300)
const Description = z.string().trim().max(20_000)
const Labels = z.array(z.string().trim().min(1).max(40)).max(20)

export const TaskCreateInput = z
  .object({
    kind: z.enum(CREATABLE_TASK_KINDS).default('task'),
    title: Title,
    description: Description.optional(),
    projectId: Uuid.optional(),
    /** Пространство задачи без проекта; по умолчанию — пространство источника или личное. */
    spaceId: Uuid.optional(),
    assigneeId: Uuid.optional(),
    coAssigneeIds: z.array(Uuid).max(20).default([]),
    controllerId: Uuid.optional(),
    dueAt: Timestamp.optional(),
    priority: TaskPriority.default(3),
    labels: Labels.default([]),
    source: TaskSource.optional(),
    /** По умолчанию — территория строки-источника, если у датасета есть поле территории. */
    territoryId: Uuid.optional(),
  })
  .superRefine((input, context) => {
    if (input.kind !== 'instruction') return
    if (!input.assigneeId) {
      context.addIssue({
        code: 'custom',
        path: ['assigneeId'],
        message: 'У поручения должен быть исполнитель',
      })
    }
    if (!input.dueAt) {
      context.addIssue({ code: 'custom', path: ['dueAt'], message: 'У поручения должен быть срок' })
    }
  })
export type TaskCreateInput = z.infer<typeof TaskCreateInput>

export const TaskUpdateInput = z
  .object({
    title: Title,
    description: Description.nullable(),
    priority: TaskPriority,
    dueAt: Timestamp.nullable(),
    assigneeId: Uuid.nullable(),
    coAssigneeIds: z.array(Uuid).max(20),
    controllerId: Uuid.nullable(),
    labels: Labels,
    territoryId: Uuid.nullable(),
  })
  .partial()
export type TaskUpdateInput = z.infer<typeof TaskUpdateInput>

/** Смена статуса обычной задачи (доска); у поручения — отдельные действия. */
export const TaskStatusInput = z.object({ status: TaskStatus })
export type TaskStatusInput = z.infer<typeof TaskStatusInput>

export const TaskReportInput = z.object({ text: z.string().trim().min(1).max(10_000) })
export type TaskReportInput = z.infer<typeof TaskReportInput>

export const TaskReturnInput = z.object({
  comment: z.string().trim().min(1).max(5_000),
  /** Новый срок доработки; без него остаётся прежний. */
  dueAt: Timestamp.optional(),
})
export type TaskReturnInput = z.infer<typeof TaskReturnInput>

export const TaskCancelInput = z.object({ comment: z.string().trim().max(5_000).optional() })
export type TaskCancelInput = z.infer<typeof TaskCancelInput>

export const TASK_SCOPES = ['mine', 'assigned_by_me', 'controlled', 'all'] as const
export const TaskScope = z.enum(TASK_SCOPES)
export type TaskScope = z.infer<typeof TaskScope>

export const TaskListQuery = z.object({
  /** «Мои» — исполняю или соисполняю; «Поручил я» — автор; «На контроле»; все доступные. */
  scope: TaskScope.default('mine'),
  projectId: Uuid.optional(),
  kind: TaskKind.optional(),
  state: z.enum(['open', 'closed', 'all']).default('open'),
  q: z.string().trim().max(200).optional(),
  /** Задачи территории и вложенных в неё единиц (паспорт территории). */
  territoryId: Uuid.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})
export type TaskListQuery = z.infer<typeof TaskListQuery>

export const TaskList = z.object({ items: z.array(TaskListItem), total: z.number().int() })
export type TaskList = z.infer<typeof TaskList>

/** Сводка «Мои задачи» (10-tasks-projects.md §6): для «Мой день» и экрана задач. */
export const TaskSummary = z.object({
  /** Открытые задачи и поручения, где я исполнитель или соисполнитель. */
  open: z.number().int(),
  overdue: z.number().int(),
  dueToday: z.number().int(),
  /** Отчёты по моим поручениям и поручениям на моём контроле, ждущие приёмки. */
  toAccept: z.number().int(),
  /** Доля закрытых в срок за 90 дней; null — закрытых со сроком нет. */
  onTimeRate: z.number().min(0).max(1).nullable(),
})
export type TaskSummary = z.infer<typeof TaskSummary>
