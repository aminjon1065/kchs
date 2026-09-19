import type { ResolvedAssignee } from './resolve.js'
import {
  type ProcessDefinition,
  type Step,
  type StepOf,
  type StepType,
  stepAssigneeExpressions,
} from './schema.js'

/**
 * Модель состояния экземпляра и переходы (ADR-0079). Чистые функции: на входе
 * определение (с шагами условий запуска), состояние и событие — на выходе новое
 * состояние и работа для исполнителя: определить назначенных (`resolve`),
 * выполнить автоматический шаг (`run`), начать ожидание (`wait`). Исполнитель —
 * ядро — сохраняет разницу состояний, открывает и закрывает Входящие, ставит
 * таймеры и публикует события.
 */

export type StepStatus = 'active' | 'completed' | 'cancelled'

export type EntryState =
  /** Очередь последовательного шага: ещё не его черёд. */
  | 'waiting'
  /** Ждём решения; у назначенного открыт элемент Входящих. */
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'remarks'
  | 'signed'
  | 'refused'
  | 'acknowledged'
  | 'registered'
  | 'resubmitted'
  | 'withdrawn'
  /** Одобрение прошлого круга засчитано (повторное согласование только отклонивших). */
  | 'carried'
  /** Решение больше не нужно: кворум набран, шаг отменён, очередь прервана. */
  | 'cancelled'
  /** Передал шаг другому: решение за тем, кому передано. */
  | 'delegated'
  /** Исполнитель поручения шага `task`. */
  | 'assigned'
  /** Получатель уведомления шага `notify`. */
  | 'notified'

export const DECISIONS = [
  'approve',
  'remarks',
  'reject',
  'sign',
  'refuse',
  'acknowledge',
  'register',
  'resubmit',
  'withdraw',
] as const
export type Decision = (typeof DECISIONS)[number]

/** Решения назначенного по типу шага. */
export const DECISIONS_BY_TYPE: Partial<Record<StepType, readonly Decision[]>> = {
  approval: ['approve', 'remarks', 'reject'],
  sign: ['sign', 'refuse'],
  acknowledge: ['acknowledge'],
  register: ['register'],
  return: ['resubmit', 'withdraw'],
}

const DECISION_STATE: Record<Decision, EntryState> = {
  approve: 'approved',
  remarks: 'remarks',
  reject: 'rejected',
  sign: 'signed',
  refuse: 'refused',
  acknowledge: 'acknowledged',
  register: 'registered',
  resubmit: 'resubmitted',
  withdraw: 'withdrawn',
}

export interface StepEntry {
  userId: string
  /** Выражение, давшее назначение; `added` — добавлен согласующим. */
  source: string
  state: EntryState
  decidedAt: string | null
  /** Кто нажал кнопку, если не сам назначенный (заместитель). */
  actorId: string | null
  /** Кто добавил согласующего. */
  addedBy: string | null
  delegatedFrom: string | null
  delegatedTo: string | null
}

export interface StepRun {
  id: string
  key: string
  type: StepType
  status: StepStatus
  outcome: string | null
  /** Круг согласования: растёт при каждой повторной отправке после возврата. */
  round: number
  sequence: number
  /** Параллельный шаг, в ветви которого исполняется шаг. */
  parentId: string | null
  branch: number | null
  /** Шаг, после которого активирован этот (`previous_step.assignees`). */
  prevId: string | null
  /** Назначенные определены (у шагов без назначенных — сразу). */
  resolved: boolean
  entries: StepEntry[]
  activatedAt: string
  completedAt: string | null
  dueAt: string | null
  result: Record<string, unknown> | null
}

export interface InstanceState {
  status: 'running' | 'finished' | 'cancelled'
  outcome: string | null
  round: number
  seq: number
  /** Правило текущего круга после возврата. */
  reapproval: 'full' | 'rejecters_only'
  finishedAt: string | null
  steps: StepRun[]
}

export type Work = { kind: 'resolve' | 'run' | 'wait'; stepId: string }

export interface Transition {
  state: InstanceState
  work: Work[]
}

/** Итог шагов для условий: `steps.legal_review.outcome = 'remarks'`. */
export type StepsScope = Record<
  string,
  { outcome: string | null; status: StepStatus; round: number }
>

export interface MachineEnv {
  /** Момент перехода, ISO 8601. */
  now: string
  newId(): string
  /** Условие шага `condition`; данные объекта и переменные подставляет исполнитель. */
  evaluate(source: string, scope: { steps: StepsScope }): boolean
}

export type ProcessErrorCode =
  | 'not_running'
  | 'unknown_step'
  | 'not_active'
  | 'not_resolved'
  | 'already_resolved'
  | 'bad_decision'
  | 'not_assignee'
  | 'not_your_turn'
  | 'already_decided'
  | 'not_allowed'
  | 'duplicate'
  | 'not_automatic'
  | 'loop'

/** Недопустимый переход: код для ответа API и сообщение. */
export class ProcessError extends Error {
  readonly code: ProcessErrorCode

  constructor(code: ProcessErrorCode, message: string) {
    super(message)
    this.name = 'ProcessError'
    this.code = code
  }
}

const OPEN: ReadonlySet<EntryState> = new Set(['pending', 'waiting'])
const DEAD: ReadonlySet<EntryState> = new Set(['cancelled', 'delegated'])
const APPROVED: ReadonlySet<EntryState> = new Set(['approved', 'carried'])

/** Сколько шагов может активировать один переход — защита от зацикливания. */
const MAX_ACTIVATIONS = 500

function entry(userId: string, source: string, state: EntryState): StepEntry {
  return {
    userId,
    source,
    state,
    decidedAt: null,
    actorId: null,
    addedBy: null,
    delegatedFrom: null,
    delegatedTo: null,
  }
}

export function initialState(): InstanceState {
  return {
    status: 'running',
    outcome: null,
    round: 1,
    seq: 0,
    reapproval: 'full',
    finishedAt: null,
    steps: [],
  }
}

class Machine {
  readonly state: InstanceState
  readonly work: Work[] = []
  private activations = 0

  constructor(
    private readonly def: ProcessDefinition,
    state: InstanceState,
    private readonly env: MachineEnv,
  ) {
    this.state = structuredClone(state)
  }

  transition(): Transition {
    return { state: this.state, work: this.work }
  }

  find(stepId: string): StepRun {
    const run = this.state.steps.find((item) => item.id === stepId)
    if (!run) throw new ProcessError('unknown_step', 'Шаг маршрута не найден')
    return run
  }

  active(stepId: string): StepRun {
    if (this.state.status !== 'running') {
      throw new ProcessError('not_running', 'Маршрут уже завершён')
    }
    const run = this.find(stepId)
    if (run.status !== 'active') throw new ProcessError('not_active', 'Шаг уже завершён')
    return run
  }

  stepOf(run: StepRun): Step {
    const step = this.def.steps[run.key]
    if (!step) throw new ProcessError('unknown_step', `В определении нет шага «${run.key}»`)
    return step
  }

  // ── Активация ───────────────────────────────────────────────────────────────

  activate(key: string, place: Pick<StepRun, 'parentId' | 'branch' | 'prevId'>): void {
    if (++this.activations > MAX_ACTIVATIONS) {
      throw new ProcessError('loop', 'Маршрут зациклился: слишком много шагов подряд')
    }
    const step = this.def.steps[key]
    if (!step) throw new ProcessError('unknown_step', `В определении нет шага «${key}»`)
    const run: StepRun = {
      id: this.env.newId(),
      key,
      type: step.type,
      status: 'active',
      outcome: null,
      round: this.state.round,
      sequence: ++this.state.seq,
      ...place,
      resolved: false,
      entries: [],
      activatedAt: this.env.now,
      completedAt: null,
      dueAt: null,
      result: null,
    }
    this.state.steps.push(run)

    switch (step.type) {
      case 'end':
        run.resolved = true
        this.completeRun(run, step.outcome)
        this.finish('finished', step.outcome)
        return
      case 'condition': {
        run.resolved = true
        const scope = { steps: stepsScope(this.state) }
        const index = step.branches.findIndex((branch) => this.env.evaluate(branch.if, scope))
        const target = index >= 0 ? step.branches[index]?.next : step.else
        if (!target) throw new ProcessError('unknown_step', `У условия «${key}» нет ветви else`)
        this.completeRun(run, index >= 0 ? `branch_${index + 1}` : 'else', { target })
        // Условие — развилка, а не шаг: «предыдущий шаг» для цели — тот же
        this.activate(target, { parentId: run.parentId, branch: run.branch, prevId: run.prevId })
        return
      }
      case 'parallel':
        run.resolved = true
        step.branches.forEach((keys, branch) => {
          const first = keys[0]
          if (first) this.activate(first, { parentId: run.id, branch, prevId: run.prevId })
        })
        if (step.branches.length === 0) {
          this.completeRun(run, 'completed')
          this.advanceAfter(run)
        }
        return
      case 'wait':
        run.resolved = true
        this.work.push({ kind: 'wait', stepId: run.id })
        return
      default:
        if (stepAssigneeExpressions(step).length > 0) {
          this.work.push({ kind: 'resolve', stepId: run.id })
        } else {
          run.resolved = true
          this.work.push({ kind: 'run', stepId: run.id })
        }
    }
  }

  // ── Назначенные ─────────────────────────────────────────────────────────────

  assign(run: StepRun, assignees: readonly ResolvedAssignee[], dueAt: string | null): void {
    if (run.resolved) throw new ProcessError('already_resolved', 'Назначенные шага уже определены')
    const step = this.stepOf(run)
    run.resolved = true
    run.dueAt = dueAt
    const entries = assignees.map((item) => entry(item.userId, item.source, 'pending'))
    switch (step.type) {
      case 'task':
        run.entries = entries.map((item) => ({ ...item, state: 'assigned' as const }))
        this.work.push({ kind: 'run', stepId: run.id })
        return
      case 'notify':
        run.entries = entries.map((item) => ({ ...item, state: 'notified' as const }))
        this.work.push({ kind: 'run', stepId: run.id })
        return
      case 'approval':
        run.entries = this.carryOver(run, entries)
        this.queue(run, step.mode)
        break
      case 'sign':
        run.entries = entries
        this.queue(run, step.mode)
        break
      default:
        run.entries = entries
    }
    if (live(run).length === 0) {
      // Ознакомить некого — шаг выполнен; решение без назначенных ждёт переназначения
      if (step.type === 'acknowledge') {
        this.completeRun(run, 'acknowledged')
        this.advanceAfter(run)
      }
      return
    }
    this.conclude(run)
  }

  /**
   * Повторное согласование только отклонивших: одобрившие прошлый круг этого
   * же шага засчитываются (`carried`), добавленные согласующие прошлого круга
   * остаются в списке.
   */
  private carryOver(run: StepRun, entries: StepEntry[]): StepEntry[] {
    if (this.state.reapproval !== 'rejecters_only') return entries
    const previous = [...this.state.steps]
      .filter((item) => item.key === run.key && item.id !== run.id && item.round < run.round)
      .sort((a, b) => b.sequence - a.sequence)[0]
    if (!previous) return entries

    const approved = new Set<string>()
    for (const item of previous.entries) {
      if (APPROVED.has(item.state)) approved.add(item.userId)
    }
    // Передавший шаг засчитывается, если одобрил тот, кому передано
    let changed = true
    while (changed) {
      changed = false
      for (const item of previous.entries) {
        if (
          item.state === 'delegated' &&
          item.delegatedTo &&
          approved.has(item.delegatedTo) &&
          !approved.has(item.userId)
        ) {
          approved.add(item.userId)
          changed = true
        }
      }
    }

    const result = [...entries]
    for (const item of previous.entries) {
      if (item.addedBy && !DEAD.has(item.state) && !result.some((e) => e.userId === item.userId)) {
        result.push({ ...entry(item.userId, item.source, 'pending'), addedBy: item.addedBy })
      }
    }
    return result.map((item) =>
      approved.has(item.userId) ? { ...item, state: 'carried' as const } : item,
    )
  }

  /** Последовательный режим: ждёт решения только первый в очереди. */
  private queue(run: StepRun, mode: string): void {
    if (mode !== 'sequential') return
    let first = true
    for (const item of run.entries) {
      if (item.state !== 'pending') continue
      if (!first) item.state = 'waiting'
      first = false
    }
  }

  // ── Решения ─────────────────────────────────────────────────────────────────

  decide(
    run: StepRun,
    userId: string,
    decision: Decision,
    actorId: string | null,
    result: Record<string, unknown> | undefined,
  ): void {
    const step = this.stepOf(run)
    if (!run.resolved) throw new ProcessError('not_resolved', 'Назначенные шага ещё не определены')
    const allowed = DECISIONS_BY_TYPE[step.type]
    if (!allowed?.includes(decision) || (step.type === 'register' && !step.assignees?.length)) {
      throw new ProcessError('bad_decision', 'Это решение для шага недоступно')
    }
    const target = run.entries.find((item) => item.userId === userId && item.state === 'pending')
    if (!target) {
      const mine = run.entries.filter((item) => item.userId === userId)
      if (mine.some((item) => item.state === 'waiting')) {
        throw new ProcessError('not_your_turn', 'Очередь согласования ещё не дошла до вас')
      }
      if (mine.length > 0) throw new ProcessError('already_decided', 'Решение уже принято')
      throw new ProcessError('not_assignee', 'Вы не назначены на этот шаг')
    }
    target.state = DECISION_STATE[decision]
    target.decidedAt = this.env.now
    target.actorId = actorId && actorId !== userId ? actorId : null
    if (result) run.result = { ...(run.result ?? {}), ...result }
    this.conclude(run)
  }

  /** Итог шага по решениям; незавершённый шаг двигает очередь. */
  private conclude(run: StepRun): void {
    const step = this.stepOf(run)
    const outcome = outcomeOf(run, step)
    if (outcome === null) {
      this.promote(run, step)
      return
    }
    for (const item of run.entries) if (OPEN.has(item.state)) item.state = 'cancelled'
    this.completeRun(run, outcome)
    switch (step.type) {
      case 'approval':
        if (outcome === 'approved') this.advanceAfter(run)
        else this.negative(run, step.onReject)
        return
      case 'sign':
        if (outcome === 'signed') this.advanceAfter(run)
        else this.negative(run, step.onReject)
        return
      case 'return':
        if (outcome === 'resubmitted') {
          this.state.round += 1
          this.state.reapproval = step.reapproval
          this.advanceAfter(run)
        } else {
          this.finish('cancelled', 'withdrawn')
        }
        return
      default:
        this.advanceAfter(run)
    }
  }

  private promote(run: StepRun, step: Step): void {
    if (!('mode' in step) || step.mode !== 'sequential') return
    if (run.entries.some((item) => item.state === 'pending')) return
    const next = run.entries.find((item) => item.state === 'waiting')
    if (next) next.state = 'pending'
  }

  /** Отклонение, замечания, отказ в подписи: `onReject` (по умолчанию `end:rejected`). */
  private negative(run: StepRun, target: string | undefined): void {
    const where = target ?? 'end:rejected'
    if (where === 'continue') {
      this.advanceAfter(run)
      return
    }
    if (where.startsWith('end:')) {
      this.finish('finished', where.slice(4))
      return
    }
    // Возврат из параллельной ветви снимает и соседние ветви: маршрут идёт заново
    for (const other of this.state.steps) if (other.status === 'active') this.cancelRun(other)
    this.activate(where, { parentId: null, branch: null, prevId: run.id })
  }

  // ── Автоматические шаги и ожидание ──────────────────────────────────────────

  complete(run: StepRun, outcome: string, result: Record<string, unknown> | undefined): void {
    const step = this.stepOf(run)
    const automatic =
      step.type === 'task' ||
      step.type === 'notify' ||
      step.type === 'set' ||
      step.type === 'call' ||
      step.type === 'wait' ||
      (step.type === 'register' && !step.assignees?.length)
    if (!automatic) {
      throw new ProcessError('not_automatic', 'Шаг завершается решением назначенных')
    }
    this.completeRun(run, outcome, result)
    this.advanceAfter(run)
  }

  // ── Переходы ────────────────────────────────────────────────────────────────

  private advanceAfter(run: StepRun): void {
    if (this.state.status !== 'running') return
    if (run.parentId) {
      const parent = this.find(run.parentId)
      if (parent.status !== 'active') return
      const parentStep = this.stepOf(parent) as StepOf<'parallel'>
      const keys = parentStep.branches[run.branch ?? -1] ?? []
      const index = keys.indexOf(run.key)
      const following = index >= 0 ? keys[index + 1] : undefined
      if (following) {
        this.activate(following, { parentId: parent.id, branch: run.branch, prevId: run.id })
        return
      }
      const done = parentStep.branches.map((branchKeys, branch) =>
        this.state.steps.some(
          (item) =>
            item.parentId === parent.id &&
            item.branch === branch &&
            item.key === branchKeys[branchKeys.length - 1] &&
            item.status === 'completed',
        ),
      )
      if (parentStep.join === 'any' || done.every(Boolean)) {
        this.cancelDescendants(parent)
        this.completeRun(parent, 'completed')
        this.advanceAfter(parent)
      }
      return
    }
    const step = this.stepOf(run)
    const next = 'next' in step ? step.next : undefined
    if (!next) throw new ProcessError('unknown_step', `У шага «${run.key}» нет next`)
    this.activate(next, { parentId: null, branch: null, prevId: run.id })
  }

  private cancelDescendants(parent: StepRun): void {
    for (const item of this.state.steps) {
      if (item.parentId !== parent.id || item.status !== 'active') continue
      this.cancelDescendants(item)
      this.cancelRun(item)
    }
  }

  completeRun(run: StepRun, outcome: string, result?: Record<string, unknown>): void {
    run.status = 'completed'
    run.outcome = outcome
    run.completedAt = this.env.now
    if (result) run.result = { ...(run.result ?? {}), ...result }
  }

  cancelRun(run: StepRun): void {
    run.status = 'cancelled'
    run.completedAt = this.env.now
    for (const item of run.entries) if (OPEN.has(item.state)) item.state = 'cancelled'
  }

  finish(status: 'finished' | 'cancelled', outcome: string): void {
    for (const run of this.state.steps) if (run.status === 'active') this.cancelRun(run)
    this.state.status = status
    this.state.outcome = outcome
    this.state.finishedAt = this.env.now
  }

  // ── Состав назначенных ──────────────────────────────────────────────────────

  add(run: StepRun, byUserId: string, userId: string): void {
    const step = this.stepOf(run)
    if (step.type !== 'approval' || !step.allowAddApprover) {
      throw new ProcessError('not_allowed', 'Добавлять согласующих на этом шаге нельзя')
    }
    const by = run.entries.findIndex((item) => item.userId === byUserId && item.state === 'pending')
    if (by < 0)
      throw new ProcessError('not_assignee', 'Добавить согласующего может согласующий шага')
    this.insert(run, userId, step.mode === 'sequential' ? 'waiting' : 'pending', by, {
      addedBy: byUserId,
      source: 'added',
    })
  }

  delegate(run: StepRun, fromUserId: string, toUserId: string): void {
    const step = this.stepOf(run)
    if (step.type !== 'approval' || !step.allowDelegate) {
      throw new ProcessError('not_allowed', 'Передать этот шаг нельзя')
    }
    const index = run.entries.findIndex(
      (item) => item.userId === fromUserId && item.state === 'pending',
    )
    if (index < 0) throw new ProcessError('not_assignee', 'Передать шаг может только назначенный')
    this.handOver(run, index, toUserId)
  }

  /** Переназначение администратором: замена одного назначенного или назначение пустого шага. */
  reassign(run: StepRun, fromUserId: string | null, userIds: readonly string[]): void {
    const step = this.stepOf(run)
    if (!run.resolved || !DECISIONS_BY_TYPE[step.type]) {
      throw new ProcessError('not_allowed', 'Переназначить можно только шаг решения')
    }
    if (fromUserId) {
      const index = run.entries.findIndex(
        (item) => item.userId === fromUserId && OPEN.has(item.state),
      )
      if (index < 0) throw new ProcessError('not_assignee', 'Этот сотрудник не ждёт решения')
      const [first, ...rest] = userIds
      if (!first) throw new ProcessError('not_allowed', 'Укажите, кому передать шаг')
      const state = run.entries[index]?.state ?? 'pending'
      this.handOver(run, index, first)
      for (const userId of rest)
        this.insert(run, userId, state, index + 1, { source: 'reassigned' })
      return
    }
    // Последовательная очередь: новые назначенные встают в конец
    const queued =
      'mode' in step && step.mode === 'sequential' && live(run).some((item) => OPEN.has(item.state))
    let at = run.entries.length - 1
    for (const userId of userIds) {
      this.insert(run, userId, queued ? 'waiting' : 'pending', at, { source: 'reassigned' })
      at += 1
    }
    if ('mode' in step) this.queue(run, step.mode)
    this.conclude(run)
  }

  private handOver(run: StepRun, index: number, toUserId: string): void {
    const from = run.entries[index] as StepEntry
    if (from.userId === toUserId) throw new ProcessError('duplicate', 'Нельзя передать шаг себе')
    const state = from.state
    from.state = 'delegated'
    from.delegatedTo = toUserId
    from.decidedAt = this.env.now
    this.insert(run, toUserId, state, index, { delegatedFrom: from.userId, source: from.source })
  }

  /** Новый назначенный после позиции `after` (-1 — в начало очереди). */
  private insert(
    run: StepRun,
    userId: string,
    state: EntryState,
    after: number,
    extra: Partial<StepEntry>,
  ): void {
    if (run.entries.some((item) => item.userId === userId && !DEAD.has(item.state))) {
      throw new ProcessError('duplicate', 'Сотрудник уже участвует в этом шаге')
    }
    const added = { ...entry(userId, extra.source ?? 'added', state), ...extra }
    run.entries.splice(after + 1, 0, added)
  }
}

function live(run: StepRun): StepEntry[] {
  return run.entries.filter((item) => !DEAD.has(item.state))
}

/**
 * Итог шага решения по ответам назначенных; `null` — ждём дальше.
 *
 * Согласование: одобрено, когда набран кворум (`all` — все, `any` — один,
 * `n` — n). Отклонение завершает шаг, как только одобрение стало невозможным;
 * замечания в параллельном режиме ждут ответов всех — автор получает замечания
 * одним возвратом. Последовательная очередь прерывается на первом ответе, после
 * которого кворум недостижим. Режим `any` — решает первый ответ.
 */
export function outcomeOf(run: StepRun, step: Step): string | null {
  const people = live(run)
  const open = people.filter((item) => OPEN.has(item.state)).length
  switch (step.type) {
    case 'approval': {
      const approvals = people.filter((item) => APPROVED.has(item.state)).length
      const rejected = people.some((item) => item.state === 'rejected')
      const remarks = people.some((item) => item.state === 'remarks')
      const negative = rejected ? 'rejected' : 'remarks'
      if (step.mode === 'any') {
        if (approvals > 0) return 'approved'
        return rejected || remarks ? negative : null
      }
      const needed =
        step.quorum === 'all'
          ? people.length
          : step.quorum === 'any'
            ? 1
            : Math.min(step.quorum, people.length)
      if (approvals >= needed) return 'approved'
      const impossible = approvals + open < needed
      if (step.mode === 'sequential') return impossible ? negative : null
      return impossible && (rejected || open === 0) ? negative : null
    }
    case 'sign':
      if (people.some((item) => item.state === 'refused')) return 'refused'
      return open === 0 ? 'signed' : null
    case 'acknowledge':
      return open === 0 ? 'acknowledged' : null
    case 'register':
      return people.some((item) => item.state === 'registered') ? 'registered' : null
    case 'return':
      if (people.some((item) => item.state === 'withdrawn')) return 'withdrawn'
      return people.some((item) => item.state === 'resubmitted') ? 'resubmitted' : null
    default:
      return null
  }
}

// ── Публичные переходы ────────────────────────────────────────────────────────

/** Запуск: активируется начальный шаг. */
export function startProcess(def: ProcessDefinition, env: MachineEnv): Transition {
  const machine = new Machine(def, initialState(), env)
  machine.activate(def.start, { parentId: null, branch: null, prevId: null })
  return machine.transition()
}

/** Назначенные определены (работа `resolve`); срок — от исполнителя по календарю. */
export function assignStep(
  def: ProcessDefinition,
  state: InstanceState,
  input: { stepId: string; assignees: readonly ResolvedAssignee[]; dueAt: string | null },
  env: MachineEnv,
): Transition {
  const machine = new Machine(def, state, env)
  machine.assign(machine.active(input.stepId), input.assignees, input.dueAt)
  return machine.transition()
}

/** Решение назначенного (`userId` — чья очередь; `actorId` — кто действует). */
export function decideStep(
  def: ProcessDefinition,
  state: InstanceState,
  input: {
    stepId: string
    userId: string
    decision: Decision
    actorId?: string | null
    result?: Record<string, unknown>
  },
  env: MachineEnv,
): Transition {
  const machine = new Machine(def, state, env)
  machine.decide(
    machine.active(input.stepId),
    input.userId,
    input.decision,
    input.actorId ?? null,
    input.result,
  )
  return machine.transition()
}

/** Автоматический шаг или ожидание выполнены (работа `run`/`wait` или модуль). */
export function completeStep(
  def: ProcessDefinition,
  state: InstanceState,
  input: { stepId: string; outcome?: string; result?: Record<string, unknown> },
  env: MachineEnv,
): Transition {
  const machine = new Machine(def, state, env)
  machine.complete(machine.active(input.stepId), input.outcome ?? 'done', input.result)
  return machine.transition()
}

export function addStepAssignee(
  def: ProcessDefinition,
  state: InstanceState,
  input: { stepId: string; byUserId: string; userId: string },
  env: MachineEnv,
): Transition {
  const machine = new Machine(def, state, env)
  machine.add(machine.active(input.stepId), input.byUserId, input.userId)
  return machine.transition()
}

export function delegateStep(
  def: ProcessDefinition,
  state: InstanceState,
  input: { stepId: string; fromUserId: string; toUserId: string },
  env: MachineEnv,
): Transition {
  const machine = new Machine(def, state, env)
  machine.delegate(machine.active(input.stepId), input.fromUserId, input.toUserId)
  return machine.transition()
}

export function reassignStep(
  def: ProcessDefinition,
  state: InstanceState,
  input: { stepId: string; fromUserId: string | null; userIds: readonly string[] },
  env: MachineEnv,
): Transition {
  const machine = new Machine(def, state, env)
  machine.reassign(machine.active(input.stepId), input.fromUserId, input.userIds)
  return machine.transition()
}

/** Отмена маршрута: активные шаги отменяются, решения не нужны. */
export function cancelProcess(
  def: ProcessDefinition,
  state: InstanceState,
  input: { outcome?: string },
  env: MachineEnv,
): Transition {
  const machine = new Machine(def, state, env)
  if (machine.state.status !== 'running') {
    throw new ProcessError('not_running', 'Маршрут уже завершён')
  }
  machine.finish('cancelled', input.outcome ?? 'cancelled')
  return machine.transition()
}

// ── Чтение состояния ──────────────────────────────────────────────────────────

/** Последняя активация каждого шага: для условий `steps.<ключ>.outcome`. */
export function stepsScope(state: InstanceState): StepsScope {
  const scope: StepsScope = {}
  for (const run of [...state.steps].sort((a, b) => a.sequence - b.sequence)) {
    scope[run.key] = { outcome: run.outcome, status: run.status, round: run.round }
  }
  return scope
}

/**
 * `previous_step.assignees`: назначенные шага, после которого активирован
 * данный; после параллельного шага — назначенные всех его ветвей.
 */
export function previousAssignees(state: InstanceState, stepId: string): string[] {
  const run = state.steps.find((item) => item.id === stepId)
  const previous = run?.prevId ? state.steps.find((item) => item.id === run.prevId) : undefined
  if (!previous) return []
  const collect = (from: StepRun): string[] => {
    if (from.type !== 'parallel') {
      return from.entries.filter((item) => item.state !== 'delegated').map((item) => item.userId)
    }
    return state.steps.filter((item) => item.parentId === from.id).flatMap(collect)
  }
  return [...new Set(collect(previous))]
}

export interface AvailableActions {
  stepId: string
  stepKey: string
  type: StepType
  /** Действие от имени замещаемого. */
  onBehalfOf: string | null
  actions: Array<Decision | 'delegate' | 'add_approver'>
  requireMfa: boolean
}

/** Что пользователь может сделать сейчас: свои шаги и шаги замещаемых. */
export function availableActions(
  def: ProcessDefinition,
  state: InstanceState,
  viewer: { userId: string; actingFor: readonly string[] },
): AvailableActions[] {
  if (state.status !== 'running') return []
  const out: AvailableActions[] = []
  for (const run of state.steps) {
    if (run.status !== 'active' || !run.resolved) continue
    const step = def.steps[run.key]
    const decisions = step ? DECISIONS_BY_TYPE[step.type] : undefined
    if (!step || !decisions) continue
    if (step.type === 'register' && !step.assignees?.length) continue
    for (const userId of [viewer.userId, ...viewer.actingFor]) {
      const mine = run.entries.some((item) => item.userId === userId && item.state === 'pending')
      if (!mine) continue
      const actions: AvailableActions['actions'] = [...decisions]
      if (step.type === 'approval' && step.allowDelegate) actions.push('delegate')
      if (step.type === 'approval' && step.allowAddApprover) actions.push('add_approver')
      out.push({
        stepId: run.id,
        stepKey: run.key,
        type: step.type,
        onBehalfOf: userId === viewer.userId ? null : userId,
        actions,
        requireMfa: step.type === 'sign' && step.requireMfa,
      })
    }
  }
  return out
}
