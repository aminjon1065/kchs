import {
  atLeast,
  CLOSED_TASK_STATUSES,
  DEFAULT_TASK_WORKFLOW,
  type Level,
  type TaskKind,
  type TaskPermissions,
  type TaskStatus,
} from '@kchs/contracts'

/** Что правила знают о задаче: вид, статус и участники. */
export interface TaskFacts {
  kind: TaskKind
  status: TaskStatus
  authorId: string | null
  assigneeId: string | null
  coAssignees: readonly string[]
  controllerId: string | null
  /** Статусы рабочего процесса проекта (для обычной задачи). */
  workflow?: readonly TaskStatus[]
  /** Запрос продления ждёт решения автора. */
  pendingExtension?: boolean
}

/** Кто действует: пользователь и, при замещении, тот, от чьего имени. */
export interface TaskActor {
  userId: string
  onBehalfOf?: string | null
}

export type TaskRole = 'author' | 'assignee' | 'co_assignee' | 'controller'

/** Роли участника: при замещении — и роли замещаемого. */
export function rolesOf(facts: TaskFacts, actor: TaskActor): Set<TaskRole> {
  const ids = new Set([actor.userId, ...(actor.onBehalfOf ? [actor.onBehalfOf] : [])])
  const roles = new Set<TaskRole>()
  if (facts.authorId && ids.has(facts.authorId)) roles.add('author')
  if (facts.assigneeId && ids.has(facts.assigneeId)) roles.add('assignee')
  if (facts.coAssignees.some((id) => ids.has(id))) roles.add('co_assignee')
  if (facts.controllerId && ids.has(facts.controllerId)) roles.add('controller')
  return roles
}

export const isClosed = (status: TaskStatus): boolean => CLOSED_TASK_STATUSES.includes(status)

/** Действия поручения и статусы, в которые они ведут. */
export const INSTRUCTION_ACTIONS = {
  start: { from: ['assigned', 'returned'], to: 'in_progress' },
  report: { from: ['in_progress', 'returned'], to: 'reported' },
  accept: { from: ['reported'], to: 'accepted' },
  return: { from: ['reported'], to: 'returned' },
  cancel: { from: ['assigned', 'in_progress', 'returned', 'reported'], to: 'cancelled' },
} as const satisfies Record<string, { from: readonly TaskStatus[]; to: TaskStatus }>

export type InstructionAction = keyof typeof INSTRUCTION_ACTIONS

const canFrom = (action: InstructionAction, status: TaskStatus): boolean =>
  (INSTRUCTION_ACTIONS[action].from as readonly TaskStatus[]).includes(status)

/**
 * Действия поручения без смены статуса (ADR-0082): запрос продления — пока
 * исполнитель работает (не отчитался); переназначение — до отчёта.
 */
export const INSTRUCTION_OPEN_STATUSES: readonly TaskStatus[] = [
  'assigned',
  'in_progress',
  'returned',
]

/**
 * Кто решает по продлению: автор поручения; нет автора (учётная запись
 * удалена) — контролёр.
 */
export function extensionDecider(
  facts: Pick<TaskFacts, 'authorId' | 'controllerId'>,
): string | null {
  return facts.authorId ?? facts.controllerId
}

/**
 * Права на задачу (10-tasks-projects.md §1, §4). Поручение: исполнитель
 * принимает и отчитывается, автор или контролёр принимает отчёт или
 * возвращает, отменяет и правит — только автор; закрыть поручение
 * исполнитель не может. Обычная задача: любой, кто правит, двигает статус
 * по рабочему процессу. Уровень доступа — из `authorize()` (или его оценки
 * для списка); роли — отношения пользователя к задаче.
 */
export function permissionsFor(facts: TaskFacts, actor: TaskActor, level: Level): TaskPermissions {
  const canEdit = atLeast(level, 'edit')
  if (facts.kind !== 'instruction') {
    const workflow = facts.workflow?.length ? facts.workflow : DEFAULT_TASK_WORKFLOW
    return {
      edit: canEdit && !isClosed(facts.status),
      start: false,
      report: false,
      accept: false,
      return: false,
      cancel: canEdit && facts.status !== 'cancelled',
      requestExtension: false,
      decideExtension: false,
      reassign: false,
      checklist: canEdit && !isClosed(facts.status),
      // Подзадачи — только у обычной задачи: у подзадачи своих нет
      subtasks: canEdit && !isClosed(facts.status) && facts.kind === 'task',
      transitions: canEdit ? workflow.filter((status) => status !== facts.status) : [],
    }
  }

  const roles = rolesOf(facts, actor)
  const author = roles.has('author')
  const assignee = roles.has('assignee')
  const reviewer = author || roles.has('controller')
  const status = facts.status
  const open = INSTRUCTION_OPEN_STATUSES.includes(status)
  const decider = extensionDecider(facts)
  const ids = new Set([actor.userId, ...(actor.onBehalfOf ? [actor.onBehalfOf] : [])])
  const permissions: TaskPermissions = {
    edit: author && canEdit && !isClosed(status),
    start: assignee && canFrom('start', status),
    report: assignee && canFrom('report', status),
    accept: reviewer && canFrom('accept', status),
    return: reviewer && canFrom('return', status),
    cancel: author && canFrom('cancel', status),
    requestExtension: assignee && open && !facts.pendingExtension,
    decideExtension:
      Boolean(facts.pendingExtension) && open && decider !== null && ids.has(decider),
    reassign: reviewer && canEdit && open,
    // Шаги исполнения ведёт сам исполнитель, автор и контролёр видят и правят их
    checklist: (author || assignee || roles.has('controller')) && !isClosed(status),
    subtasks: false,
    transitions: [],
  }
  const byAction: Array<[InstructionAction, boolean]> = [
    ['start', permissions.start],
    ['report', permissions.report],
    ['accept', permissions.accept],
    ['return', permissions.return],
    ['cancel', permissions.cancel],
  ]
  permissions.transitions = [
    ...new Set(
      byAction.filter(([, allowed]) => allowed).map(([action]) => INSTRUCTION_ACTIONS[action].to),
    ),
  ]
  return permissions
}

/** Начальный статус: поручение назначено, задача — к выполнению. */
export function initialStatus(kind: TaskKind, workflow?: readonly TaskStatus[]): TaskStatus {
  if (kind === 'instruction') return 'assigned'
  return workflow?.[0] ?? 'todo'
}

/**
 * Просрочена: срок прошёл, а задача не закрыта. Отчёт поручения, сданный до
 * срока и ждущий приёмки, — не просрочка: исполнитель успел (ADR-0082).
 */
export function isOverdue(
  status: TaskStatus,
  dueAt: string | null,
  now = new Date(),
  reportedAt: string | null = null,
): boolean {
  if (!dueAt || isClosed(status)) return false
  const due = new Date(dueAt).getTime()
  const fact = status === 'reported' && reportedAt ? new Date(reportedAt).getTime() : now.getTime()
  return fact > due
}
