import type { LangText, UserRef } from '@kchs/contracts'
import type { ProcessInstanceView, Step } from '@kchs/process'
import { VISIBLE_STEP_TYPES } from './labels.js'
import { type FlowNode, layoutOf } from './model.js'

export type OverviewStepState = 'done' | 'current' | 'upcoming' | 'rejected'

export interface OverviewStep {
  key: string
  type: string
  name: LangText | null
  state: OverviewStepState
  /** Назначенные пройденного или текущего шага. */
  people: UserRef[]
  /** Шаг ждёт смотрящего (или того, кого он замещает). */
  mine: boolean
  activatedAt: string | null
  completedAt: string | null
  dueAt: string | null
  overdue: boolean
  /** Норма шага по определению маршрута. */
  normHours: number | null
  normWorkingDays: number | null
}

export interface RouteOverview {
  steps: OverviewStep[]
  /** Сроки маршрута в календарных часах — экстренный маршрут (ADR-0131). */
  hours: boolean
  /** Текущий шаг смотрящего. */
  mine: OverviewStep | null
}

const REJECTED = new Set(['rejected', 'refused', 'withdrawn', 'timeout'])

function norm(step: Step | undefined): Pick<OverviewStep, 'normHours' | 'normWorkingDays'> {
  const due = (step ?? {}) as { dueHours?: number; dueWorkingDays?: number }
  return { normHours: due.dueHours ?? null, normWorkingDays: due.dueWorkingDays ?? null }
}

/** Ответы, которые ещё не решение: ждёт, в очереди, передал другому. */
const UNDECIDED = new Set(['pending', 'waiting', 'delegated', 'assigned', 'notified', 'cancelled'])

/**
 * Кто на шаге: у пройденного — кто решил (за него — заместитель), у текущего — кто ждёт
 * решения; без таких — все назначенные. Каждый — один раз.
 */
function peopleOf(step: ProcessInstanceView['steps'][number]): UserRef[] {
  const decided = step.assignees.filter((entry) => entry.decidedAt && !UNDECIDED.has(entry.state))
  const pending = step.assignees.filter((entry) => entry.state === 'pending')
  const chosen =
    step.status === 'active'
      ? pending.length > 0
        ? pending
        : step.assignees
      : decided.length > 0
        ? decided
        : step.assignees
  return [...new Map(chosen.map((entry) => [entry.user.id, entry.actor ?? entry.user])).values()]
}

/** Основная линия определения по порядку; ветви параллельной группы — подряд. */
function mainLine(nodes: readonly FlowNode[]): FlowNode[] {
  const line: FlowNode[] = []
  for (const node of nodes) {
    if (node.branches) for (const branch of node.branches) line.push(...mainLine(branch))
    else line.push(node)
  }
  return line
}

/**
 * Обзор маршрута шагами (ADR-0230): прошлое — по шагам экземпляра текущего круга (с
 * вставленными условием шагами и возвратами), будущее — по определению, после последнего
 * пройденного шага основной линии. Завершённый маршрут будущего не имеет.
 */
export function routeOverviewOf(view: ProcessInstanceView): RouteOverview {
  const definitionSteps = view.definition.steps as Record<string, Step>
  const mineIds = new Set(view.myActions.map((action) => action.stepId))
  const executed = view.steps
    .filter(
      (step) =>
        step.round === view.round &&
        VISIBLE_STEP_TYPES.has(step.type) &&
        step.status !== 'cancelled',
    )
    .sort((a, b) => a.sequence - b.sequence)

  const steps: OverviewStep[] = executed.map((step) => ({
    key: step.key,
    type: step.type,
    name: step.name,
    state:
      step.status === 'active'
        ? 'current'
        : step.outcome && REJECTED.has(step.outcome)
          ? 'rejected'
          : 'done',
    people: peopleOf(step),
    mine: step.status === 'active' && mineIds.has(step.id),
    activatedAt: step.activatedAt,
    completedAt: step.completedAt,
    dueAt: step.dueAt,
    overdue: step.overdue,
    ...norm(definitionSteps[step.key]),
  }))

  if (view.status === 'running') {
    const line = mainLine(layoutOf(view.definition).main.nodes).filter((node) =>
      VISIBLE_STEP_TYPES.has(node.step.type),
    )
    const seen = new Set(executed.map((step) => step.key))
    const lastIndex = line.reduce((last, node, index) => (seen.has(node.key) ? index : last), -1)
    for (const node of line.slice(lastIndex + 1)) {
      if (seen.has(node.key)) continue
      steps.push({
        key: node.key,
        type: node.step.type,
        name: (node.step as { name?: LangText }).name ?? null,
        state: 'upcoming',
        people: [],
        mine: false,
        activatedAt: null,
        completedAt: null,
        dueAt: null,
        overdue: false,
        ...norm(node.step),
      })
    }
  }

  const hours = Object.values(definitionSteps).some(
    (step) => typeof (step as { dueHours?: number }).dueHours === 'number',
  )
  return { steps, hours, mine: steps.find((step) => step.mine) ?? null }
}
