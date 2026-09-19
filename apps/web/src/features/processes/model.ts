import type { DefinitionIssue, ProcessDefinition, Step, StepType } from '@kchs/process'

/**
 * Модель конструктора маршрутов (08-documents.md §4, ADR-0087): определение
 * маршрута — единственный источник правды; конструктор показывает его списком
 * шагов с вложенными параллельными группами и правит чистыми функциями.
 * Смысл (достижимость, выражения, исполнители модулей) проверяет сервер.
 */

export type Definition = ProcessDefinition
type Steps = Definition['steps']

/** Шаги палитры «Добавить шаг» в порядке меню. */
export const STEP_PALETTE: readonly StepType[] = [
  'approval',
  'sign',
  'register',
  'acknowledge',
  'task',
  'notify',
  'wait',
  'set',
  'call',
  'condition',
  'parallel',
  'return',
  'end',
]

/** Шаги, которые нельзя ставить в ветвь параллельной группы (ADR-0079). */
const NOT_IN_BRANCH: ReadonlySet<StepType> = new Set(['condition', 'return', 'end'])

/** Шаг без `next`: после него в линии ничего не вставить. */
const TERMINAL: ReadonlySet<StepType> = new Set(['condition', 'end'])

export function canBeInBranch(type: StepType): boolean {
  return !NOT_IN_BRANCH.has(type)
}

export function isTerminal(step: Step): boolean {
  return TERMINAL.has(step.type)
}

export interface FlowNode {
  key: string
  step: Step
  /** Ветви параллельной группы: шаги по порядку. */
  branches?: FlowNode[][]
}

export interface FlowChain {
  nodes: FlowNode[]
  /** Цепочка переходит к уже показанному шагу (цикл возврата, слияние ветвей условия). */
  continuesTo: string | null
  /** Откуда сюда переходят (для цепочек вне основной линии). */
  enteredFrom: Array<{ key: string; via: 'onReject' | 'branch' | 'else' | 'next' }>
}

export interface FlowLayout {
  main: FlowChain
  /** Цепочки вне основной линии: ветви условий, возвраты, недостижимые шаги. */
  others: FlowChain[]
  /** Шаг ветви → ключ параллельной группы и номер ветви. */
  owners: Map<string, { parallel: string; branch: number }>
}

function nextOf(step: Step | undefined): string | undefined {
  return step && 'next' in step ? step.next : undefined
}

/** Ключи шагов, живущих в ветвях параллельных групп (с владельцем). */
function branchOwners(steps: Steps): Map<string, { parallel: string; branch: number }> {
  const owners = new Map<string, { parallel: string; branch: number }>()
  for (const [key, step] of Object.entries(steps)) {
    if (step.type !== 'parallel') continue
    step.branches.forEach((branch, index) => {
      for (const member of branch) owners.set(member, { parallel: key, branch: index })
    })
  }
  return owners
}

/** Вторичные переходы шага: отклонение, ветви условия, «иначе». */
function sideEdges(step: Step): Array<{ target: string; via: 'onReject' | 'branch' | 'else' }> {
  const edges: Array<{ target: string; via: 'onReject' | 'branch' | 'else' }> = []
  if ((step.type === 'approval' || step.type === 'sign') && step.onReject) {
    if (step.onReject !== 'continue' && !step.onReject.startsWith('end:')) {
      edges.push({ target: step.onReject, via: 'onReject' })
    }
  }
  if (step.type === 'condition') {
    for (const branch of step.branches) edges.push({ target: branch.next, via: 'branch' })
    if (step.else) edges.push({ target: step.else, via: 'else' })
  }
  return edges
}

/**
 * Раскладка определения: основная линия от `start` по `next`, параллельные
 * группы с ветвями внутри, остальные шаги — цепочками в порядке обнаружения
 * (переходы условий и отклонений), недостижимые — в конце по ключу.
 */
export function layoutOf(definition: Definition): FlowLayout {
  const { steps } = definition
  const owners = branchOwners(steps)
  const shown = new Set<string>()

  const node = (key: string, step: Step): FlowNode => {
    shown.add(key)
    if (step.type !== 'parallel') return { key, step }
    return {
      key,
      step,
      branches: step.branches.map((branch) =>
        branch.flatMap((member) => {
          const inner = steps[member]
          return inner && !shown.has(member) ? [node(member, inner)] : []
        }),
      ),
    }
  }

  const chainFrom = (start: string | undefined): FlowChain => {
    const nodes: FlowNode[] = []
    let key = start
    while (key && steps[key] && !shown.has(key) && !owners.has(key)) {
      const step = steps[key] as Step
      nodes.push(node(key, step))
      key = nextOf(step)
    }
    return { nodes, continuesTo: key && steps[key] ? key : null, enteredFrom: [] }
  }

  const main = chainFrom(definition.start)
  const others: FlowChain[] = []
  // Обход в ширину по вторичным переходам всех показанных шагов
  const queue: FlowNode[] = [...main.nodes]
  const visitNested = (item: FlowNode) => {
    for (const branch of item.branches ?? []) queue.push(...branch)
  }
  main.nodes.forEach(visitNested)
  while (queue.length > 0) {
    const current = queue.shift() as FlowNode
    for (const edge of sideEdges(current.step)) {
      if (shown.has(edge.target) || owners.has(edge.target) || !steps[edge.target]) continue
      const chain = chainFrom(edge.target)
      if (chain.nodes.length === 0) continue
      others.push(chain)
      queue.push(...chain.nodes)
      chain.nodes.forEach(visitNested)
    }
  }
  // Недостижимые шаги верхнего уровня
  for (const key of Object.keys(steps).sort()) {
    if (shown.has(key) || owners.has(key)) continue
    const chain = chainFrom(key)
    if (chain.nodes.length > 0) others.push(chain)
  }
  // Кто ведёт к началу каждой цепочки
  for (const chain of others) {
    const head = chain.nodes[0]?.key
    if (!head) continue
    for (const [key, step] of Object.entries(steps)) {
      if (nextOf(step) === head) chain.enteredFrom.push({ key, via: 'next' })
      for (const edge of sideEdges(step)) {
        if (edge.target === head) chain.enteredFrom.push({ key, via: edge.via })
      }
    }
  }
  return { main, others, owners }
}

/** Свободный ключ шага: `approval_1`, `approval_2`… */
export function newStepKey(definition: Definition, type: StepType): string {
  const taken = new Set([
    ...Object.keys(definition.steps),
    ...definition.conditions.map((condition) => condition.key).filter(Boolean),
  ])
  for (let index = 1; ; index++) {
    const key = `${type}_${index}`
    if (!taken.has(key)) return key
  }
}

/**
 * Шаг с разумными значениями по умолчанию: назначенные сразу заданы, чтобы
 * черновик сохранялся без ошибок формы (правятся в инспекторе).
 */
export function defaultStep(type: StepType, next?: string): Step {
  const tail = next ? { next } : {}
  switch (type) {
    case 'approval':
      return {
        type,
        mode: 'parallel',
        quorum: 'all',
        assignees: ['unit_head(author.unit)'],
        dueWorkingDays: 3,
        allowAddApprover: false,
        allowDelegate: true,
        ...tail,
      }
    case 'sign':
      return {
        type,
        mode: 'parallel',
        assignees: ['unit_head(author.unit)'],
        dueWorkingDays: 2,
        requireMfa: true,
        signatureKind: 'simple',
        ...tail,
      }
    case 'register':
      return { type, ...tail }
    case 'acknowledge':
      return { type, assignees: ['author'], ...tail }
    case 'task':
      return {
        type,
        // i18n-ignore: название по умолчанию — данные маршрута на трёх языках, а не текст интерфейса
        title: { ru: 'Задача', en: 'Task', tg: 'Вазифа' },
        assignees: ['author'],
        params: {},
        ...tail,
      }
    case 'notify':
      return { type, to: 'author', ...tail }
    case 'wait':
      return { type, durationWorkingDays: 1, ...tail }
    case 'set':
      return { type, field: 'status', value: '', ...tail }
    case 'call':
      return { type, action: 'module.action', params: {}, ...tail }
    case 'return':
      return { type, to: 'author', reapproval: 'full', ...tail }
    case 'condition':
      return {
        type,
        branches: [{ if: 'object.fields.amount > 1000000', next: next ?? '' }],
        ...(next ? { else: next } : {}),
      }
    case 'parallel':
      return { type, branches: [], join: 'all', ...tail }
    case 'end':
      return { type, outcome: 'completed' }
  }
}

function withoutNext(step: Step): Step {
  if (!('next' in step)) return step
  const { next: _next, ...rest } = step
  return rest as Step
}

function setNext(step: Step, next: string | undefined): Step {
  if (step.type === 'condition' || step.type === 'end') return step
  if (next === undefined) return withoutNext(step)
  return { ...step, next } as Step
}

/**
 * Вставить шаг в основную линию после `afterKey` (`null` — в начало маршрута).
 * Параллельная группа получает две ветви с согласованием в каждой.
 */
export function insertAfter(
  definition: Definition,
  afterKey: string | null,
  type: StepType,
): { definition: Definition; key: string } {
  const key = newStepKey(definition, type)
  const steps: Steps = { ...definition.steps }
  const after = afterKey ? steps[afterKey] : undefined
  if (afterKey && (!after || isTerminal(after))) return { definition, key: '' }
  const next = afterKey ? nextOf(after) : definition.start
  let created = defaultStep(type, next)
  let start = definition.start
  if (type === 'parallel') {
    const withBranches = addBranchSteps({ ...definition, steps }, key, 2)
    Object.assign(steps, withBranches.members)
    created = { ...created, branches: withBranches.branches } as Step
  }
  steps[key] = created
  if (afterKey && after) steps[afterKey] = setNext(after, key)
  else start = key
  return { definition: { ...definition, start, steps }, key }
}

function addBranchSteps(
  definition: Definition,
  parallelKey: string,
  count: number,
): { members: Steps; branches: string[][] } {
  const members: Steps = {}
  const branches: string[][] = []
  const probe = { ...definition, steps: { ...definition.steps, [parallelKey]: defaultStep('end') } }
  for (let index = 0; index < count; index++) {
    const key = newStepKey({ ...probe, steps: { ...probe.steps, ...members } }, 'approval')
    members[key] = withoutNext(defaultStep('approval'))
    branches.push([key])
  }
  return { members, branches }
}

/** Вставить шаг в ветвь параллельной группы на позицию `position`. */
export function insertIntoBranch(
  definition: Definition,
  parallelKey: string,
  branch: number,
  position: number,
  type: StepType,
): { definition: Definition; key: string } {
  const group = definition.steps[parallelKey]
  if (group?.type !== 'parallel' || !canBeInBranch(type) || !group.branches[branch]) {
    return { definition, key: '' }
  }
  const key = newStepKey(definition, type)
  const steps: Steps = { ...definition.steps }
  let created = withoutNext(defaultStep(type))
  if (type === 'parallel') {
    const nested = addBranchSteps({ ...definition, steps }, key, 2)
    Object.assign(steps, nested.members)
    created = { ...created, branches: nested.branches } as Step
  }
  steps[key] = created
  const branches = group.branches.map((members, index) =>
    index === branch ? [...members.slice(0, position), key, ...members.slice(position)] : members,
  )
  steps[parallelKey] = { ...group, branches }
  return { definition: { ...definition, steps }, key }
}

/** Новая ветвь группы с шагом согласования. */
export function addBranch(definition: Definition, parallelKey: string): Definition {
  const group = definition.steps[parallelKey]
  if (group?.type !== 'parallel') return definition
  const { members, branches } = addBranchSteps(definition, parallelKey, 1)
  return {
    ...definition,
    steps: {
      ...definition.steps,
      ...members,
      [parallelKey]: { ...group, branches: [...group.branches, ...branches] },
    },
  }
}

/** Все шаги группы с вложенными группами — для удаления. */
function membersDeep(steps: Steps, parallelKey: string): string[] {
  const group = steps[parallelKey]
  if (group?.type !== 'parallel') return []
  return group.branches.flat().flatMap((member) => [member, ...membersDeep(steps, member)])
}

/** Удалить ветвь группы с её шагами; последняя ветвь удаляет группу. */
export function removeBranch(
  definition: Definition,
  parallelKey: string,
  branch: number,
): Definition {
  const group = definition.steps[parallelKey]
  if (group?.type !== 'parallel' || !group.branches[branch]) return definition
  if (group.branches.length === 1) return removeStep(definition, parallelKey)
  const steps: Steps = { ...definition.steps }
  for (const member of group.branches[branch] ?? []) {
    for (const key of [member, ...membersDeep(steps, member)]) delete steps[key]
  }
  steps[parallelKey] = { ...group, branches: group.branches.filter((_, index) => index !== branch) }
  return { ...definition, steps }
}

/**
 * Удалить шаг. Переходы `next` и начало маршрута сшиваются через удалённый
 * шаг; отклонение на него сбрасывается к умолчанию; прочие ссылки (ветви
 * условия, `return`) остаются — их покажет проверка.
 */
export function removeStep(definition: Definition, key: string): Definition {
  const removed = definition.steps[key]
  if (!removed) return definition
  const steps: Steps = { ...definition.steps }
  const gone = new Set([key, ...membersDeep(steps, key)])
  for (const item of gone) delete steps[item]
  const through = nextOf(removed)
  for (const [other, step] of Object.entries(steps)) {
    let updated = step
    if (nextOf(updated) === key) updated = setNext(updated, through)
    if ((updated.type === 'approval' || updated.type === 'sign') && updated.onReject === key) {
      const { onReject: _onReject, ...rest } = updated
      updated = rest as Step
    }
    if (updated.type === 'parallel' && updated.branches.flat().some((item) => gone.has(item))) {
      const branches = updated.branches
        .map((members) => members.filter((member) => !gone.has(member)))
        .filter((members) => members.length > 0)
      updated = { ...updated, branches }
    }
    if (updated !== step) steps[other] = updated
  }
  const result: Definition = {
    ...definition,
    start: definition.start === key ? (through ?? definition.start) : definition.start,
    steps,
    timers: definition.timers.filter((timer) => !gone.has(timer.step)),
    conditions: definition.conditions.map((condition) =>
      condition.insertBefore === key && through
        ? { ...condition, insertBefore: through }
        : condition,
    ),
  }
  // Опустевшая группа удаляется целиком
  const empty = Object.entries(steps).find(
    ([, step]) => step.type === 'parallel' && step.branches.length === 0,
  )
  return empty ? removeStep(result, empty[0]) : result
}

/**
 * Сдвинуть шаг на позицию выше (`-1`) или ниже (`+1`): в ветви — перестановкой,
 * в основной линии — пересшивкой `next` (только между шагами с `next`).
 */
export function moveStep(definition: Definition, key: string, direction: -1 | 1): Definition {
  const layout = layoutOf(definition)
  const owner = layout.owners.get(key)
  if (owner) {
    const group = definition.steps[owner.parallel]
    if (group?.type !== 'parallel') return definition
    const members = [...(group.branches[owner.branch] ?? [])]
    const index = members.indexOf(key)
    const target = index + direction
    if (index < 0 || target < 0 || target >= members.length) return definition
    ;[members[index], members[target]] = [members[target] as string, members[index] as string]
    const branches = group.branches.map((item, i) => (i === owner.branch ? members : item))
    return {
      ...definition,
      steps: { ...definition.steps, [owner.parallel]: { ...group, branches } },
    }
  }
  const chain = layout.main.nodes.map((item) => item.key)
  const index = chain.indexOf(key)
  const target = index + direction
  if (index < 0 || target < 0 || target >= chain.length) return definition
  const order = [...chain]
  ;[order[index], order[target]] = [order[target] as string, order[index] as string]
  // Шаги без `next` (условие, завершение) остаются последними
  if (order.slice(0, -1).some((item) => isTerminal(definition.steps[item] as Step))) {
    return definition
  }
  const steps: Steps = { ...definition.steps }
  const tail =
    layout.main.continuesTo ?? nextOf(definition.steps[chain[chain.length - 1] as string])
  order.forEach((item, position) => {
    const step = steps[item] as Step
    steps[item] = setNext(step, order[position + 1] ?? tail)
  })
  return { ...definition, start: order[0] as string, steps }
}

/** Все ссылки на ключ шага — для переименования. */
function renameIn(step: Step, from: string, to: string): Step {
  const swap = (value: string | undefined) => (value === from ? to : value)
  let result: Step = step
  if ('next' in result && result.next === from) result = { ...result, next: to } as Step
  if ((result.type === 'approval' || result.type === 'sign') && result.onReject === from) {
    result = { ...result, onReject: to }
  }
  if (result.type === 'condition') {
    result = {
      ...result,
      branches: result.branches.map((branch) => ({ ...branch, next: swap(branch.next) as string })),
      ...(result.else ? { else: swap(result.else) as string } : {}),
    }
  }
  if (result.type === 'parallel') {
    result = {
      ...result,
      branches: result.branches.map((members) => members.map((member) => swap(member) as string)),
    }
  }
  return result
}

/** Переименовать ключ шага во всех ссылках; занятый или неверный ключ — без изменений. */
export function renameStep(definition: Definition, from: string, to: string): Definition {
  if (from === to || !definition.steps[from] || definition.steps[to]) return definition
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(to)) return definition
  const steps: Steps = {}
  for (const [key, step] of Object.entries(definition.steps)) {
    steps[key === from ? to : key] = renameIn(step, from, to)
  }
  return {
    ...definition,
    start: definition.start === from ? to : definition.start,
    steps,
    timers: definition.timers.map((timer) =>
      timer.step === from ? { ...timer, step: to } : timer,
    ),
    conditions: definition.conditions.map((condition) =>
      condition.insertBefore === from ? { ...condition, insertBefore: to } : condition,
    ),
  }
}

/** Заменить шаг целиком (правка инспектора). */
export function updateStep(definition: Definition, key: string, step: Step): Definition {
  if (!definition.steps[key]) return definition
  return { ...definition, steps: { ...definition.steps, [key]: step } }
}

export type IssueTarget =
  | { kind: 'step'; key: string }
  | { kind: 'route'; section: 'general' | 'variables' | 'timers' | 'conditions' }

/** Куда относится проблема проверки: шаг или раздел настроек маршрута. */
export function issueTarget(issue: Pick<DefinitionIssue, 'path'>): IssueTarget {
  const [head, second] = issue.path.split('.')
  if (head === 'steps' && second) return { kind: 'step', key: second }
  if (head === 'variables') return { kind: 'route', section: 'variables' }
  if (head === 'timers') return { kind: 'route', section: 'timers' }
  if (head === 'conditions') return { kind: 'route', section: 'conditions' }
  return { kind: 'route', section: 'general' }
}

/** Проблемы по шагам: ключ шага → проблемы. */
export function issuesByStep(issues: readonly DefinitionIssue[]): Map<string, DefinitionIssue[]> {
  const result = new Map<string, DefinitionIssue[]>()
  for (const issue of issues) {
    const target = issueTarget(issue)
    if (target.kind !== 'step') continue
    result.set(target.key, [...(result.get(target.key) ?? []), issue])
  }
  return result
}

/** Пустой маршрут: согласование руководителем подразделения автора и завершение. */
export function blankDefinition(input: {
  key: string
  objectType: string
  name: Definition['name']
}): Definition {
  return {
    version: 1,
    key: input.key,
    objectType: input.objectType,
    name: input.name,
    variables: {},
    start: 'approval_1',
    steps: {
      approval_1: defaultStep('approval', 'end') as Step,
      end: defaultStep('end'),
    },
    timers: [],
    conditions: [],
  }
}
