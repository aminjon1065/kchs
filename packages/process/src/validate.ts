import { checkEvaluable } from '@kchs/query/expr'
import type { z } from 'zod'
import type { DefinitionIssue } from './api.js'
import { type AssigneeExpr, assigneeNodes, checkAssignee } from './assignee.js'
import {
  branchPlaces,
  conditionKey,
  descendantsOf,
  rejectStepTarget,
  topLevelEdges,
} from './graph.js'
import { nextOf, ProcessDefinition, type Step, stepAssigneeExpressions } from './schema.js'

/**
 * Проверка определения маршрута (contracts/process-definition.md §Семантика):
 * форма по схеме, ссылки шагов, место шагов в параллельных ветвях,
 * достижимость, путь к завершению, циклы только через `return`, выражения
 * назначений и условий. Ошибки не дают опубликовать версию; предупреждения —
 * подсказки конструктору. Путь проблемы — в определении:
 * `steps.legal_review.assignees.1`.
 */
export interface ValidationResult {
  ok: boolean
  definition: ProcessDefinition | null
  issues: DefinitionIssue[]
}

/** Корни ссылок в условиях: при запуске, в шаге `condition`, в фильтре `wait`. */
export const CONDITION_ROOTS = {
  start: ['object', 'var', 'author', 'initiator'],
  step: ['object', 'var', 'author', 'initiator', 'steps'],
  wait: ['object', 'var', 'author', 'initiator', 'steps', 'event'],
} as const

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/

/** Запись срока ожидания `until`: дата, момент, `var:<имя>` или `field:<путь>`. */
export function parseUntil(
  until: string,
):
  | { kind: 'date'; value: string }
  | { kind: 'var'; name: string }
  | { kind: 'field'; path: string[] }
  | null {
  const value = until.trim()
  if (ISO_DATE.test(value) || (ISO_DATETIME.test(value) && !Number.isNaN(Date.parse(value)))) {
    return { kind: 'date', value }
  }
  const variable = /^var:([a-z][a-zA-Z0-9_]*)$/.exec(value)
  if (variable) return { kind: 'var', name: variable[1] as string }
  const field = /^field:([a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*)$/.exec(value)
  if (field) return { kind: 'field', path: (field[1] as string).split('.') }
  return null
}

function zodIssues(error: z.ZodError): DefinitionIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    code: 'schema',
    message: issue.message,
    severity: 'error' as const,
  }))
}

export function validateDefinition(input: unknown): ValidationResult {
  const parsed = ProcessDefinition.safeParse(input)
  if (!parsed.success) return { ok: false, definition: null, issues: zodIssues(parsed.error) }
  const issues = checkDefinition(parsed.data)
  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    definition: parsed.data,
    issues,
  }
}

class Collector {
  readonly issues: DefinitionIssue[] = []

  error(path: string, code: string, message: string): void {
    this.issues.push({ path, code, message, severity: 'error' })
  }

  warning(path: string, code: string, message: string): void {
    this.issues.push({ path, code, message, severity: 'warning' })
  }
}

/** Смысловая проверка определения, прошедшего схему. */
export function checkDefinition(def: ProcessDefinition): DefinitionIssue[] {
  const out = new Collector()
  const steps = def.steps
  const places = branchPlaces(def)
  const exists = (key: string) => Object.hasOwn(steps, key)

  // ── Параллельные ветви: шаги существуют, стоят в одной ветви, без вложения в себя
  const seenInBranches = new Map<string, string>()
  for (const [key, step] of Object.entries(steps)) {
    if (step.type !== 'parallel') continue
    step.branches.forEach((keys, branch) => {
      keys.forEach((member, index) => {
        const path = `steps.${key}.branches.${branch}.${index}`
        if (!exists(member)) {
          out.error(path, 'unknown_step', `Нет шага «${member}»`)
          return
        }
        if (member === def.start) {
          out.error(path, 'start_in_branch', `Начальный шаг «${member}» не может стоять в ветви`)
        }
        const other = seenInBranches.get(member)
        if (other) {
          out.error(path, 'branch_duplicate', `Шаг «${member}» уже стоит в ветви «${other}»`)
        } else {
          seenInBranches.set(member, key)
        }
      })
    })
    if (descendantsOf(def, key).includes(key)) {
      out.error(`steps.${key}.branches`, 'branch_cycle', `Параллельный шаг «${key}» вложен в себя`)
    }
  }

  const targetOk = (path: string, target: string) => {
    if (!exists(target)) {
      out.error(path, 'unknown_step', `Нет шага «${target}»`)
      return false
    }
    if (places.has(target)) {
      out.error(
        path,
        'target_in_branch',
        `На шаг «${target}» из параллельной ветви переходить нельзя: он исполняется в ветви`,
      )
      return false
    }
    return true
  }

  if (!exists(def.start)) out.error('start', 'unknown_step', `Нет шага «${def.start}»`)

  const variableContext = { variables: def.variables }

  /** Выражения назначений по месту: одна строка — путь поля, список — с индексом. */
  const checkAssignees = (path: string, value: string | readonly string[], timer = false) => {
    const entries: Array<[string, string]> =
      typeof value === 'string'
        ? [[path, value]]
        : value.map((source, index): [string, string] => [`${path}.${index}`, source])
    const parsed: AssigneeExpr[] = []
    for (const [where, source] of entries) {
      const { expr, problem } = checkAssignee(source, { ...variableContext, timer })
      if (problem) {
        out.error(where, 'assignee_invalid', `${problem.message} (позиция ${problem.position + 1})`)
      }
      if (expr) parsed.push(expr)
    }
    return parsed
  }

  const checkCondition = (path: string, source: string, roots: readonly string[]) => {
    const problem = checkEvaluable(source, roots)
    if (problem) {
      out.error(
        path,
        'condition_invalid',
        `${problem.message} (позиция ${problem.position + 1})${problem.hint ? `. ${problem.hint}` : ''}`,
      )
    }
  }

  // ── Шаги
  for (const [key, step] of Object.entries(steps)) {
    const path = `steps.${key}`
    const inBranch = places.has(key)
    const next = nextOf(step)

    if (inBranch) {
      if (step.type === 'end' || step.type === 'return' || step.type === 'condition') {
        out.error(
          `${path}.type`,
          'branch_step_type',
          `Шаг типа «${step.type}» не может стоять в параллельной ветви`,
        )
      }
      if (next) {
        out.error(
          `${path}.next`,
          'branch_next',
          'У шага параллельной ветви нет next: шаги ветви идут по порядку',
        )
      }
    } else if (step.type !== 'end' && step.type !== 'condition' && !next) {
      out.error(`${path}.next`, 'next_required', 'Укажите следующий шаг (next)')
    }
    if (next) targetOk(`${path}.next`, next)

    if (step.type === 'approval' || step.type === 'sign') {
      const target = rejectStepTarget(step.onReject)
      if (target) targetOk(`${path}.onReject`, target)
    }
    if (step.type === 'approval' && step.mode === 'any' && typeof step.quorum === 'number') {
      out.warning(
        `${path}.quorum`,
        'quorum_ignored',
        'В режиме any решает первый ответ — кворум не учитывается',
      )
    }

    if (step.type === 'condition') {
      step.branches.forEach((branch, index) => {
        targetOk(`${path}.branches.${index}.next`, branch.next)
        checkCondition(`${path}.branches.${index}.if`, branch.if, CONDITION_ROOTS.step)
      })
      if (step.else) targetOk(`${path}.else`, step.else)
      else
        out.error(
          `${path}.else`,
          'else_required',
          'Укажите шаг else — на случай, когда ни одно условие не выполнено',
        )
    }

    checkDeadline(out, path, step)

    if (step.type === 'wait') {
      if (
        !step.event &&
        !step.until &&
        step.durationWorkingDays === undefined &&
        step.durationHours === undefined
      ) {
        out.error(
          path,
          'wait_empty',
          'Шаг wait ждёт событие (event) или срок (until, durationWorkingDays, durationHours)',
        )
      }
      if (step.filter) {
        if (!step.event) {
          out.error(
            `${path}.filter`,
            'filter_without_event',
            'Фильтр задаётся вместе с событием (event)',
          )
        }
        checkCondition(`${path}.filter`, step.filter, CONDITION_ROOTS.wait)
      }
      if (step.until) {
        const until = parseUntil(step.until)
        if (!until) {
          out.error(
            `${path}.until`,
            'until_invalid',
            'Срок: дата, момент ISO 8601, var:<имя> или field:<путь>',
          )
        } else if (until.kind === 'var' && !def.variables[until.name]) {
          out.error(`${path}.until`, 'unknown_variable', `Нет переменной «${until.name}»`)
        }
      }
    }

    const [field, value] = assigneeField(step)
    const parsed = value === null ? [] : checkAssignees(`${path}.${field}`, value)
    if (key === def.start && usesPrevious(parsed)) {
      out.warning(
        `${path}.${field}`,
        'no_previous_step',
        'У начального шага нет предыдущего: previous_step.assignees будет пустым',
      )
    }
  }

  // ── Таймеры
  def.timers.forEach((timer, index) => {
    const path = `timers.${index}`
    if (timer.step !== '*' && !exists(timer.step)) {
      out.error(`${path}.step`, 'unknown_step', `Нет шага «${timer.step}»`)
    }
    timer.onOverdue.forEach((action, actionIndex) => {
      checkAssignees(`${path}.onOverdue.${actionIndex}.to`, action.to, true)
    })
  })

  // ── Условия запуска: вставка перед шагом верхнего уровня
  const insertedKeys = new Set<string>()
  def.conditions.forEach((condition, index) => {
    const path = `conditions.${index}`
    targetOk(`${path}.insertBefore`, condition.insertBefore)
    checkCondition(`${path}.if`, condition.if, CONDITION_ROOTS.start)
    const key = conditionKey(def, index)
    if (exists(key) || insertedKeys.has(key)) {
      out.error(`${path}.key`, 'duplicate_key', `Ключ «${key}» уже занят — задайте key условия`)
    }
    insertedKeys.add(key)
    const step = condition.step as Step
    checkDeadline(out, `${path}.step`, step)
    if (nextOf(step)) {
      out.error(
        `${path}.step.next`,
        'inserted_next',
        'У вставляемого шага нет next: он ведёт к insertBefore',
      )
    }
    if (step.type === 'approval' || step.type === 'sign') {
      const target = rejectStepTarget(step.onReject)
      if (target) targetOk(`${path}.step.onReject`, target)
    }
    const [field, value] = assigneeField(step)
    if (value !== null) checkAssignees(`${path}.step.${field}`, value)
  })

  // ── Достижимость, завершение, циклы — по переходам верхнего уровня
  if (exists(def.start)) {
    const edges = topLevelEdges(def)
    const reachable = reachableFrom(def.start, edges)
    // Шаг ветви достижим вместе со своим параллельным шагом
    for (const key of [...reachable]) {
      for (const inner of descendantsOf(def, key)) reachable.add(inner)
    }
    for (const key of Object.keys(steps)) {
      if (!reachable.has(key)) {
        out.error(`steps.${key}`, 'unreachable', `Шаг «${key}» недостижим от начала маршрута`)
      }
    }

    const ends = Object.entries(steps)
      .filter(([key, step]) => step.type === 'end' && !places.has(key))
      .map(([key]) => key)
    if (ends.length === 0) {
      out.error('steps', 'end_required', 'Нужен шаг завершения (type: end)')
    } else {
      const reverse = new Map<string, string[]>()
      for (const [from, targets] of edges) {
        for (const target of targets) reverse.set(target, [...(reverse.get(target) ?? []), from])
      }
      const canFinish = new Set<string>()
      for (const end of ends) for (const key of reachableFrom(end, reverse)) canFinish.add(key)
      for (const key of edges.keys()) {
        if (reachable.has(key) && !canFinish.has(key)) {
          out.error(`steps.${key}`, 'no_path_to_end', `От шага «${key}» нет пути к завершению`)
        }
      }
    }

    const withoutReturn = new Map<string, string[]>()
    for (const [from, targets] of edges) {
      if (steps[from]?.type === 'return') continue
      withoutReturn.set(
        from,
        targets.filter((target) => steps[target]?.type !== 'return'),
      )
    }
    const cycle = findCycle(withoutReturn)
    if (cycle) {
      out.error(
        `steps.${cycle[0]}`,
        'cycle_without_return',
        `Цикл без шага return: ${cycle.join(' → ')}`,
      )
    }
  }

  return out.issues
}

/**
 * Срок шага задаётся одним способом: рабочими днями по производственному
 * календарю или календарными часами (ADR-0131) — оба сразу неоднозначны.
 */
function checkDeadline(out: Collector, path: string, step: Step): void {
  if ('dueHours' in step && step.dueHours !== undefined && step.dueWorkingDays !== undefined) {
    out.error(
      `${path}.dueHours`,
      'due_conflict',
      'Срок задаётся одним способом: рабочими днями (dueWorkingDays) или часами (dueHours)',
    )
  }
  if (
    step.type === 'wait' &&
    step.durationHours !== undefined &&
    step.durationWorkingDays !== undefined
  ) {
    out.error(
      `${path}.durationHours`,
      'due_conflict',
      'Срок ожидания задаётся одним способом: рабочими днями (durationWorkingDays) или часами (durationHours)',
    )
  }
}

/** Поле шага с выражениями назначений и его значение (`null` — у шага их нет). */
function assigneeField(step: Step): [string, string | readonly string[] | null] {
  switch (step.type) {
    case 'return':
    case 'notify':
      return ['to', step.to]
    case 'register':
      return ['assignees', step.assignees ?? null]
    default: {
      const list = stepAssigneeExpressions(step)
      return ['assignees', list.length > 0 ? list : null]
    }
  }
}

function usesPrevious(parsed: readonly AssigneeExpr[]): boolean {
  return parsed.some((expr) => assigneeNodes(expr).some((node) => node.kind === 'previous_step'))
}

function reachableFrom(start: string, edges: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const next of edges.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return seen
}

/** Первый найденный цикл: список ключей от начала цикла до возврата в него. */
function findCycle(edges: ReadonlyMap<string, readonly string[]>): string[] | null {
  const state = new Map<string, 'open' | 'done'>()
  const stack: string[] = []
  const visit = (node: string): string[] | null => {
    state.set(node, 'open')
    stack.push(node)
    for (const next of edges.get(node) ?? []) {
      if (!edges.has(next)) continue
      const mark = state.get(next)
      if (mark === 'open') {
        const from = stack.indexOf(next)
        return [...stack.slice(from), next]
      }
      if (!mark) {
        const found = visit(next)
        if (found) return found
      }
    }
    stack.pop()
    state.set(node, 'done')
    return null
  }
  for (const node of edges.keys()) {
    if (state.has(node)) continue
    const found = visit(node)
    if (found) return found
  }
  return null
}
