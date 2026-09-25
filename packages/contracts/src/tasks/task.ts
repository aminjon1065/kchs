import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { BigIntString, DateOnly, Timestamp, Uuid } from '../common/primitives.js'

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
  /**
   * Резолюция документа (08-documents.md §6, ADR-0082): поручения создаёт модуль
   * документов в транзакции резолюции; закрытие всех поручений документа — событие
   * `task.source_closed`.
   */
  z.object({
    kind: z.literal('resolution'),
    /** Документ, на котором наложена резолюция. */
    objectId: Uuid,
    resolutionId: Uuid,
    /** Подпись источника на момент создания («Вх. 12/26 · резолюция»). */
    label: z.string().trim().max(300).nullish(),
  }),
])
export type TaskSource = z.infer<typeof TaskSource>

/** Объект реестра, от которого пришла задача: документ, датасет строки или иной объект. */
export function taskSourceObjectId(source: TaskSource | null | undefined): string | null {
  if (!source) return null
  return source.kind === 'dataset_row' ? source.datasetId : source.objectId
}

/** Срок в рабочих днях: 0 — конец ближайшего рабочего дня, дальше — N-й рабочий день. */
export const WorkingDays = z.number().int().min(0).max(366)

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
  /** Запросить продление срока (исполнитель поручения). */
  requestExtension: z.boolean(),
  /** Согласовать или отклонить запрос продления (автор поручения). */
  decideExtension: z.boolean(),
  /** Переназначить исполнителя (автор или контролёр поручения). */
  reassign: z.boolean(),
  /** Статусы, в которые можно перевести задачу одним действием (доска). */
  transitions: z.array(TaskStatus),
})
export type TaskPermissions = z.infer<typeof TaskPermissions>

export const TaskProjectRef = z.object({ id: Uuid, key: z.string(), name: z.string() })
export type TaskProjectRef = z.infer<typeof TaskProjectRef>

/** Объект, приложенный к отчёту: файл-вложение или подготовленный документ. */
export const TaskResultObject = z.object({
  id: Uuid,
  type: z.string(),
  /** null — смотрящему объект не виден: показывается «нет доступа». */
  title: z.string().nullable(),
})
export type TaskResultObject = z.infer<typeof TaskResultObject>

export const TaskResult = z.object({
  text: z.string(),
  reportedAt: Timestamp,
  reportedBy: UserRef.nullable(),
  /** Вложения и ссылки на объекты — результат исполнения (ADR-0082). */
  objects: z.array(TaskResultObject).default([]),
})
export type TaskResult = z.infer<typeof TaskResult>

/**
 * Готовый отчёт по поручению (N22, ADR-0136): система готовит его по событию — ответ на
 * входящий зарегистрирован и отправлен; исполнитель отправляет его одной кнопкой.
 */
export const TASK_REPORT_DRAFT_CAUSES = ['reply_dispatched'] as const
export const TaskReportDraft = z.object({
  text: z.string(),
  objects: z.array(TaskResultObject).default([]),
  cause: z.enum(TASK_REPORT_DRAFT_CAUSES),
  preparedAt: Timestamp,
})
export type TaskReportDraft = z.infer<typeof TaskReportDraft>

/**
 * Основание изменения срока: назначен при создании, изменён автором, новый срок
 * при возврате, продление по запросу, вслед за основным поручением (часть
 * соисполнителя).
 */
export const TASK_DUE_REASONS = ['set', 'edit', 'return', 'extension', 'parent'] as const
export const TaskDueReason = z.enum(TASK_DUE_REASONS)
export type TaskDueReason = z.infer<typeof TaskDueReason>

/** Запись истории сроков: кто, когда, с какого на какой, основание. */
export const TaskDueChange = z.object({
  id: z.string(),
  from: Timestamp.nullable(),
  to: Timestamp.nullable(),
  /** Срок задан как «N рабочих дней». */
  workingDays: z.number().int().nullable(),
  reason: TaskDueReason,
  comment: z.string().nullable(),
  actor: UserRef.nullable(),
  /** Действие выполнено заместителем от имени этого сотрудника. */
  onBehalfOf: UserRef.nullable(),
  at: Timestamp,
})
export type TaskDueChange = z.infer<typeof TaskDueChange>

export const TASK_EXTENSION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const
export const TaskExtensionStatus = z.enum(TASK_EXTENSION_STATUSES)
export type TaskExtensionStatus = z.infer<typeof TaskExtensionStatus>

/** Запрос продления срока поручения и решение по нему. */
export const TaskExtension = z.object({
  id: Uuid,
  status: TaskExtensionStatus,
  /** Срок на момент запроса. */
  fromDueAt: Timestamp.nullable(),
  requestedDueAt: Timestamp,
  requestedWorkingDays: z.number().int().nullable(),
  reason: z.string(),
  requestedBy: UserRef.nullable(),
  requestedAt: Timestamp,
  decidedBy: UserRef.nullable(),
  decidedAt: Timestamp.nullable(),
  decisionComment: z.string().nullable(),
  /** Согласованный срок: запрошенный или другой, назначенный автором. */
  approvedDueAt: Timestamp.nullable(),
})
export type TaskExtension = z.infer<typeof TaskExtension>

/** Часть соисполнителя «в части касающейся» — в карточке основного поручения. */
export const TaskPart = z.object({
  id: Uuid,
  key: z.string(),
  status: TaskStatus,
  assignee: UserRef.nullable(),
  dueAt: Timestamp.nullable(),
  overdue: z.boolean(),
  completedAt: Timestamp.nullable(),
})
export type TaskPart = z.infer<typeof TaskPart>

/** Основное поручение для части соисполнителя. */
export const TaskParentRef = z.object({ id: Uuid, key: z.string(), title: z.string() })
export type TaskParentRef = z.infer<typeof TaskParentRef>

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
  /** Срок задан как «N рабочих дней» по производственному календарю. */
  dueWorkingDays: z.number().int().nullable(),
  /** Первоначальный срок — до продлений и изменений. */
  originalDueAt: Timestamp.nullable(),
  /** Сколько раз срок продлевали по запросу исполнителя: отметка «продлено». */
  extensions: z.number().int(),
  /** Исполнитель принял поручение к исполнению (или начал задачу). */
  startedAt: Timestamp.nullable(),
  completedAt: Timestamp.nullable(),
  result: TaskResult.nullable(),
  /** Готовый отчёт — только исполнителю, пока поручение не отчитано. */
  reportDraft: TaskReportDraft.nullable().default(null),
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
  /** Основное поручение, если это часть соисполнителя. */
  parent: TaskParentRef.nullable(),
  /** Части соисполнителей основного поручения (видимые смотрящему). */
  parts: z.array(TaskPart),
  /** История сроков: от назначения до последнего продления. */
  dueHistory: z.array(TaskDueChange),
  /** Последний запрос продления; `pending` — ждёт решения автора. */
  extension: TaskExtension.nullable(),
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
  reportDraft: true,
  returnComment: true,
  coAssignees: true,
  controller: true,
  source: true,
  parent: true,
  parts: true,
  dueHistory: true,
  extension: true,
}).extend({
  /** Часть соисполнителя (у основного поручения — null). */
  parentId: Uuid.nullable(),
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
    /** Срок «N рабочих дней» от сегодняшнего дня по производственному календарю. */
    dueWorkingDays: WorkingDays.optional(),
    priority: TaskPriority.default(3),
    labels: Labels.default([]),
    source: TaskSource.optional(),
    /** По умолчанию — территория строки-источника, если у датасета есть поле территории. */
    territoryId: Uuid.optional(),
  })
  .superRefine((input, context) => {
    if (input.dueAt !== undefined && input.dueWorkingDays !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['dueWorkingDays'],
        message: 'Срок задаётся датой или числом рабочих дней, не тем и другим',
      })
    }
    if (input.kind !== 'instruction') return
    if (!input.assigneeId) {
      context.addIssue({
        code: 'custom',
        path: ['assigneeId'],
        message: 'У поручения должен быть исполнитель',
      })
    }
    if (!input.dueAt && input.dueWorkingDays === undefined) {
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
    /** Новый срок «N рабочих дней» от сегодня (вместо даты). */
    dueWorkingDays: WorkingDays,
    /** Основание изменения срока — в историю сроков. */
    dueComment: z.string().trim().max(1000).nullable(),
    assigneeId: Uuid.nullable(),
    coAssigneeIds: z.array(Uuid).max(20),
    controllerId: Uuid.nullable(),
    labels: Labels,
    territoryId: Uuid.nullable(),
  })
  .partial()
  .refine((input) => input.dueAt === undefined || input.dueWorkingDays === undefined, {
    message: 'Срок задаётся датой или числом рабочих дней, не тем и другим',
    path: ['dueWorkingDays'],
  })
export type TaskUpdateInput = z.infer<typeof TaskUpdateInput>

/** Смена статуса обычной задачи (доска); у поручения — отдельные действия. */
export const TaskStatusInput = z.object({ status: TaskStatus })
export type TaskStatusInput = z.infer<typeof TaskStatusInput>

export const TaskReportInput = z.object({
  text: z.string().trim().min(1).max(10_000),
  /**
   * Вложения (файлы, загруженные к поручению) и ссылки на объекты — например,
   * подготовленный документ; каждый должен быть виден исполнителю.
   */
  objectIds: z.array(Uuid).max(20).default([]),
})
export type TaskReportInput = z.infer<typeof TaskReportInput>

export const TaskReturnInput = z
  .object({
    comment: z.string().trim().min(1).max(5_000),
    /** Новый срок доработки; без него остаётся прежний. */
    dueAt: Timestamp.optional(),
    dueWorkingDays: WorkingDays.optional(),
  })
  .refine((input) => input.dueAt === undefined || input.dueWorkingDays === undefined, {
    message: 'Срок задаётся датой или числом рабочих дней, не тем и другим',
    path: ['dueWorkingDays'],
  })
export type TaskReturnInput = z.infer<typeof TaskReturnInput>

/** Запрос продления: желаемый срок (дата или рабочие дни от сегодня) и обоснование. */
export const TaskExtensionRequestInput = z
  .object({
    dueAt: Timestamp.optional(),
    dueWorkingDays: WorkingDays.optional(),
    reason: z.string().trim().min(1).max(2_000),
  })
  .superRefine((input, context) => {
    if ((input.dueAt === undefined) === (input.dueWorkingDays === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['dueAt'],
        message: 'Укажите желаемый срок датой или числом рабочих дней',
      })
    }
  })
export type TaskExtensionRequestInput = z.infer<typeof TaskExtensionRequestInput>

/** Решение автора: согласовать (запрошенный или другой срок) или отказать с причиной. */
export const TaskExtensionDecisionInput = z
  .object({
    decision: z.enum(['approve', 'reject']),
    dueAt: Timestamp.optional(),
    dueWorkingDays: WorkingDays.optional(),
    comment: z.string().trim().max(2_000).optional(),
  })
  .superRefine((input, context) => {
    if (input.dueAt !== undefined && input.dueWorkingDays !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['dueWorkingDays'],
        message: 'Срок задаётся датой или числом рабочих дней, не тем и другим',
      })
    }
    if (input.decision === 'reject' && !input.comment) {
      context.addIssue({ code: 'custom', path: ['comment'], message: 'Укажите причину отказа' })
    }
  })
export type TaskExtensionDecisionInput = z.infer<typeof TaskExtensionDecisionInput>

/** Переназначение исполнителя поручения автором или контролёром. */
export const TaskReassignInput = z.object({
  assigneeId: Uuid,
  comment: z.string().trim().max(2_000).optional(),
})
export type TaskReassignInput = z.infer<typeof TaskReassignInput>

export const TaskCancelInput = z.object({ comment: z.string().trim().max(5_000).optional() })
export type TaskCancelInput = z.infer<typeof TaskCancelInput>

/** «Команда» — поручения подчинённых руководителя (03-access-model.md, ADR-0082). */
export const TASK_SCOPES = ['mine', 'assigned_by_me', 'controlled', 'team', 'all'] as const
export const TaskScope = z.enum(TASK_SCOPES)
export type TaskScope = z.infer<typeof TaskScope>

export const TaskListQuery = z.object({
  /**
   * «Мои» — исполняю (у обычной задачи — и соисполняю); «Поручил я» — автор
   * основных поручений; «На контроле»; «Команда» — исполняют подчинённые; все доступные.
   */
  scope: TaskScope.default('mine'),
  projectId: Uuid.optional(),
  kind: TaskKind.optional(),
  state: z.enum(['open', 'closed', 'all']).default('open'),
  q: z.string().trim().max(200).optional(),
  /** Задачи территории и вложенных в неё единиц (паспорт территории). */
  territoryId: Uuid.optional(),
  /** Исполнитель — переход из «Нагрузки» к списку. */
  assigneeId: Uuid.optional(),
  /** Срок с и по (включительно), день по часам смотрящего. */
  dueFrom: DateOnly.optional(),
  dueTo: DateOnly.optional(),
  /** Только просроченные. */
  overdue: z.stringbool().optional(),
  /** Только без срока. */
  noDue: z.stringbool().optional(),
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
