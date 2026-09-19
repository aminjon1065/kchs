import type { InboxItem, InboxKind } from '@kchs/contracts'
import {
  assignStep,
  completeStep,
  DECISIONS_BY_TYPE,
  dueOf,
  type InstanceState,
  isDecisionStep,
  type MachineEnv,
  type ProcessDefinition,
  ProcessError,
  parseUntil,
  previousAssignees,
  resolveAssignees,
  type Step,
  type StepRun,
  stepAssigneeExpressions,
  type Transition,
} from '@kchs/process'
import { evaluateCondition } from '@kchs/query/expr'
import { eq } from 'drizzle-orm'
import { config } from '~/shared/config/index.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { BusinessCalendar } from '../business-calendar/service.js'
import { directory } from '../directory/port.js'
import { publishEvent } from '../events/publisher.js'
import { InboxService } from '../inbox/service.js'
import { kernelDirectory } from './directory.js'
import {
  type ProcessInstanceInfo,
  type ProcessObjectData,
  type ProcessStepInfo,
  processObjectProvider,
  processObservers,
  processStepHandler,
  type StepHandlerResult,
} from './registry.js'
import type { LoadedInstance, StepMeta } from './store.js'
import { saveState } from './store.js'
import { dueTimers, nextTimerAt, scheduleTimerJob, untilMoment } from './timer-schedule.js'

/**
 * Исполнение переходов в транзакции (ADR-0079): модель из `@kchs/process`
 * решает, что дальше, исполнитель определяет назначенных, выполняет
 * автоматические шаги модулей, ставит таймеры, а по разнице состояний —
 * открывает и закрывает Входящие, публикует события и вызывает хуки модуля.
 */

/** Вид элемента Входящих шага решения. */
export const INBOX_KIND: Record<string, InboxKind> = {
  approval: 'approve',
  sign: 'sign',
  acknowledge: 'acknowledge',
  register: 'register',
  return: 'revise',
}

const MAX_WORK = 1000

/** Ошибка модели переходов — ответ API. */
export function processFailure(error: unknown): unknown {
  if (!(error instanceof ProcessError)) return error
  switch (error.code) {
    case 'not_assignee':
      return errors.forbidden(error.message, { reason: error.code })
    case 'unknown_step':
      return errors.notFound('Шаг маршрута')
    case 'not_running':
    case 'not_active':
    case 'already_decided':
    case 'already_resolved':
    case 'not_your_turn':
      return errors.conflict(error.message, { reason: error.code })
    case 'loop':
      return errors.internal(error.message)
    default:
      return errors.validation(error.message, [
        { path: 'action', message: error.message, code: error.code },
      ])
  }
}

/** Переход модели с ошибками API вместо ошибок модели. */
export function transition(apply: () => Transition): Transition {
  try {
    return apply()
  } catch (error) {
    throw processFailure(error)
  }
}

/**
 * Данные объекта: поставщик модуля, иначе — строка реестра (автор — создатель,
 * поля — сводные `meta`).
 */
export async function loadObjectData(
  tx: Executor,
  object: LoadedInstance['object'],
): Promise<ProcessObjectData> {
  const provider = processObjectProvider(object.type)
  if (provider) {
    const data = await provider.load(tx, object.id)
    if (!data) throw errors.notFound('Объект маршрута')
    return data
  }
  const [row] = await tx
    .select({ createdBy: objects.createdBy })
    .from(objects)
    .where(eq(objects.id, object.id))
    .limit(1)
  return {
    authorId: row?.createdBy ?? object.ownerId,
    spaceId: object.spaceId,
    title: object.title,
    fields: object.meta ?? {},
  }
}

/** Данные для условий: `object.*`, `var.*`, `author.*`, `initiator.*` (+ `steps`, `event`). */
export interface EvaluationData {
  object: Record<string, unknown>
  var: Record<string, unknown>
  author: { id: string | null; unit: string | null }
  initiator: { id: string | null }
}

export function evaluationData(
  object: LoadedInstance['object'],
  data: ProcessObjectData,
  variables: Record<string, unknown>,
  initiatorId: string | null,
  authorUnit: string | null,
): EvaluationData {
  return {
    object: {
      ...(data.props ?? {}),
      id: object.id,
      type: object.type,
      title: data.title,
      spaceId: data.spaceId,
      fields: data.fields,
    },
    var: variables,
    author: { id: data.authorId, unit: authorUnit },
    initiator: { id: initiatorId },
  }
}

/** Условие над данными: ссылки — пути в объекте данных; ошибка вычисления — «не выполнено». */
export function evaluate(source: string, data: Record<string, unknown>): boolean {
  try {
    return evaluateCondition(source, {
      resolve: (path) => {
        let current: unknown = data
        for (const part of path) {
          if (current === null || typeof current !== 'object') return undefined
          current = (current as Record<string, unknown>)[part]
        }
        return current
      },
      timezone: config().TZ,
    })
  } catch {
    return false
  }
}

/**
 * Один проход изменений экземпляра в транзакции: `apply` — переходы модели с
 * работой (назначенные, автоматические шаги, ожидание), `commit` — запись и
 * последствия. Экземпляр заблокирован (`loadInstance(..., {lock: true})`).
 */
export class Execution {
  readonly before: InstanceState
  private readonly metaBefore: Map<string, StepMeta>
  state: InstanceState
  private data: ProcessObjectData | null = null
  private authorUnit: string | null = null
  private readonly now = new Date()

  constructor(
    private readonly tx: Executor,
    private readonly ctx: Ctx,
    readonly loaded: LoadedInstance,
  ) {
    this.before = structuredClone(loaded.state)
    this.state = loaded.state
    this.metaBefore = new Map(
      [...loaded.meta].map(([id, meta]) => [id, structuredClone(meta)] as const),
    )
  }

  get def(): ProcessDefinition {
    return this.loaded.def
  }

  async objectData(): Promise<ProcessObjectData> {
    if (!this.data) {
      this.data = await loadObjectData(this.tx, this.loaded.object)
      this.authorUnit =
        this.data.authorUnitId !== undefined
          ? this.data.authorUnitId
          : this.data.authorId
            ? await directory().primaryUnit(this.data.authorId)
            : null
    }
    return this.data
  }

  /** Данные условий после `objectData()`. */
  evaluationData(): EvaluationData {
    const data = this.data as ProcessObjectData
    return evaluationData(
      this.loaded.object,
      data,
      this.loaded.context.variables,
      this.loaded.instance.startedBy,
      this.authorUnit,
    )
  }

  /** Среда перехода модели: время прохода, идентификаторы, условия шагов. */
  env(): MachineEnv {
    const base = this.evaluationData()
    return {
      now: this.now.toISOString(),
      newId,
      evaluate: (source, scope) => evaluate(source, { ...base, steps: scope.steps }),
    }
  }

  instanceInfo(): ProcessInstanceInfo {
    const { instance, context, version, object } = this.loaded
    return {
      id: instance.id,
      definitionId: instance.definitionId,
      definitionKey: instance.definitionKey,
      version,
      objectId: instance.objectId,
      objectType: object.type,
      initiatorId: instance.startedBy,
      variables: context.variables,
      round: this.state.round,
    }
  }

  stepInfo(run: StepRun): ProcessStepInfo {
    return {
      id: run.id,
      key: run.key,
      type: run.type,
      definition: this.stepOf(run),
      round: run.round,
      assignees: run.entries.map((entry) => entry.userId),
      dueAt: run.dueAt,
      outcome: run.outcome,
      result: run.result,
    }
  }

  stepOf(run: StepRun): Step {
    const step = this.def.steps[run.key]
    if (!step) throw errors.internal(`В определении нет шага «${run.key}»`)
    return step
  }

  run(stepId: string): StepRun {
    const run = this.state.steps.find((item) => item.id === stepId)
    if (!run) throw errors.notFound('Шаг маршрута')
    return run
  }

  /** Переход модели и вся работа, которую он породил. */
  async apply(next: Transition): Promise<void> {
    await this.objectData()
    this.state = next.state
    const queue = [...next.work]
    let done = 0
    while (queue.length > 0) {
      if (++done > MAX_WORK) throw errors.internal('Маршрут не сходится: слишком много шагов')
      const item = queue.shift()
      if (!item) break
      const run = this.state.steps.find((candidate) => candidate.id === item.stepId)
      if (run?.status !== 'active') continue
      const step = this.stepOf(run)
      if (item.kind === 'resolve') {
        const assignees = await this.resolve(run, step)
        const due = dueOf(step)
        const dueAt =
          due !== undefined && (isDecisionStep(step) || step.type === 'task')
            ? (
                await BusinessCalendar.deadline(new Date(run.activatedAt), due, {
                  executor: this.tx,
                })
              ).dueAt.toISOString()
            : null
        const result = transition(() =>
          assignStep(this.def, this.state, { stepId: run.id, assignees, dueAt }, this.env()),
        )
        this.state = result.state
        queue.push(...result.work)
      } else if (item.kind === 'run') {
        const outcome = await this.runStep(run, step)
        if (outcome === 'wait') continue
        const result = transition(() =>
          completeStep(
            this.def,
            this.state,
            {
              stepId: run.id,
              outcome: outcome.outcome ?? 'done',
              ...(outcome.result ? { result: outcome.result } : {}),
            },
            this.env(),
          ),
        )
        this.state = result.state
        queue.push(...result.work)
      } else if (item.kind === 'wait' && step.type === 'wait') {
        await this.startWait(run, step)
      }
    }
  }

  /** Назначенные шага: выражения против справочника и данных объекта. */
  private async resolve(run: StepRun, step: Step) {
    const data = await this.objectData()
    const { context, instance } = this.loaded
    const variableTypes = Object.fromEntries(
      Object.entries(this.def.variables).map(([name, variable]) => [name, variable.type]),
    )
    const result = await resolveAssignees(
      stepAssigneeExpressions(step),
      {
        authorId: data.authorId,
        authorUnitId: this.authorUnit,
        initiatorId: instance.startedBy,
        spaceId: data.spaceId ?? this.loaded.object.spaceId,
        variables: context.variables,
        variableTypes,
        fields: data.fields,
        chosen: context.chosen[run.key] ?? [],
        previousAssignees: previousAssignees(this.state, run.id),
      },
      kernelDirectory,
    )
    return result.assignees
  }

  /** Автоматический шаг: уведомление и поле — сразу, `call`/`task`/`register` — модуль. */
  private async runStep(
    run: StepRun,
    step: Step,
  ): Promise<Exclude<StepHandlerResult, 'wait'> | 'wait'> {
    const objectType = this.loaded.object.type
    switch (step.type) {
      case 'notify':
        // Уведомление отправит подписчик по событию активации шага
        return { outcome: 'sent' }
      case 'set': {
        const provider = processObjectProvider(objectType)
        if (!provider?.setField) {
          throw errors.conflict(
            `Маршрут не может изменить поле: тип «${objectType}» не поддерживает шаг set`,
          )
        }
        await provider.setField(this.tx, this.ctx, this.loaded.object.id, step.field, step.value)
        return { outcome: 'done' }
      }
      case 'call':
      case 'task':
      case 'register': {
        const handler = processStepHandler(
          step.type,
          objectType,
          step.type === 'call' ? step.action : undefined,
        )
        if (!handler) {
          throw errors.conflict(
            `Нет исполнителя шага ${step.type}${step.type === 'call' ? ` ${step.action}` : ''} для типа «${objectType}»`,
          )
        }
        return handler.execute(this.tx, this.ctx, {
          instance: this.instanceInfo(),
          step: this.stepInfo(run),
          params: step.type === 'register' ? { journal: step.journal ?? null } : step.params,
          actor: null,
          payload: {},
        })
      }
      default:
        return { outcome: 'done' }
    }
  }

  /** Ожидание: событие об этом же объекте и/или срок. */
  private async startWait(run: StepRun, step: Extract<Step, { type: 'wait' }>): Promise<void> {
    const moments: string[] = []
    if (step.durationWorkingDays !== undefined) {
      const { dueAt } = await BusinessCalendar.deadline(
        new Date(run.activatedAt),
        step.durationWorkingDays,
        { executor: this.tx },
      )
      moments.push(dueAt.toISOString())
    }
    if (step.until) {
      const until = parseUntil(step.until)
      const data = await this.objectData()
      const value =
        until?.kind === 'date'
          ? until.value
          : until?.kind === 'var'
            ? this.loaded.context.variables[until.name]
            : until?.kind === 'field'
              ? until.path.reduce<unknown>(
                  (current, part) =>
                    current && typeof current === 'object'
                      ? (current as Record<string, unknown>)[part]
                      : undefined,
                  data.fields,
                )
              : null
      const moment = untilMoment(value)
      if (moment) moments.push(moment)
    }
    moments.sort()
    const at = moments[0]
    this.loaded.meta.set(run.id, {
      timers: at ? { wait: { at } } : {},
      nextTimerAt: at ?? null,
      waitEvent: step.event ?? null,
    })
    // Срок ожидания уже прошёл (дата в прошлом) — шаг сработает при ближайшем обходе таймеров
  }

  /**
   * Запись и последствия: строки шагов и экземпляра, Входящие, таймеры,
   * события, хуки модуля, пересчёт прав участников.
   */
  async commit(): Promise<void> {
    const before = this.before
    const after = this.state
    const previous = new Map(before.steps.map((run) => [run.id, run]))

    // Таймеры сроков новых шагов решения; у завершённых шагов ближайший момент снимается
    for (const run of after.steps) {
      const meta = this.loaded.meta.get(run.id)
      if (run.status !== 'active') {
        if (meta?.nextTimerAt) this.loaded.meta.set(run.id, { ...meta, nextTimerAt: null })
        continue
      }
      const old = previous.get(run.id)
      // Срок у шага появился в этом проходе (назначенные определены) — таймеры срока
      if (run.dueAt && !old?.dueAt && !meta?.timers.overdue && isDecisionStep(this.stepOf(run))) {
        const timers = await dueTimers(this.tx, run.dueAt, this.now)
        this.loaded.meta.set(run.id, {
          timers,
          nextTimerAt: nextTimerAt(timers),
          waitEvent: meta?.waitEvent ?? null,
        })
      }
    }

    await saveState(this.tx, this.loaded, before, after, this.metaBefore)

    for (const run of after.steps) {
      const meta = this.loaded.meta.get(run.id)
      if (
        run.status === 'active' &&
        meta?.nextTimerAt &&
        meta.nextTimerAt !== this.metaBefore.get(run.id)?.nextTimerAt
      ) {
        await scheduleTimerJob(this.tx, run.id, meta.nextTimerAt)
      }
    }

    await this.syncInbox(previous, after)

    const provider = processObjectProvider(this.loaded.object.type)
    const instance = this.instanceInfo()
    const object = this.eventObject()
    for (const run of [...after.steps].sort((a, b) => a.sequence - b.sequence)) {
      const old = previous.get(run.id)
      if (!old) {
        const step = this.stepOf(run)
        await publishEvent(this.tx, this.ctx, {
          type: 'process.step_activated',
          object,
          payload: {
            instanceId: instance.id,
            stepId: run.id,
            stepKey: run.key,
            kind: run.type,
            assignees: run.entries.map((entry) => entry.userId),
            dueAt: run.dueAt,
            template: step.type === 'notify' ? (step.template ?? null) : null,
          },
        })
        await provider?.onStepActivated?.(this.tx, this.ctx, {
          instance,
          step: this.stepInfo(run),
        })
      }
      if (run.status === 'completed' && old?.status !== 'completed') {
        await publishEvent(this.tx, this.ctx, {
          type: 'process.step_completed',
          object,
          payload: {
            instanceId: instance.id,
            stepId: run.id,
            stepKey: run.key,
            kind: run.type,
            outcome: run.outcome ?? 'done',
          },
        })
        await provider?.onStepCompleted?.(this.tx, this.ctx, {
          instance,
          step: this.stepInfo(run),
        })
      }
      if (run.status === 'cancelled' && old?.status === 'active') {
        await this.cancelModuleStep(run)
      }
    }

    await this.notifyObservers(previous, after)

    if (before.status === 'running' && after.status !== 'running') {
      await publishEvent(this.tx, this.ctx, {
        type: 'process.finished',
        object,
        payload: {
          instanceId: instance.id,
          definitionKey: instance.definitionKey,
          status: after.status as 'finished' | 'cancelled',
          outcome: after.outcome ?? after.status,
        },
      })
      await provider?.onFinished?.(this.tx, this.ctx, {
        instance,
        status: after.status as 'finished' | 'cancelled',
        outcome: after.outcome ?? after.status,
      })
    }

    // Участники шагов видят объект по политике типа: состав изменился — права тоже
    if (participantsKey(before) !== participantsKey(after)) {
      await publishEvent(this.tx, this.ctx, {
        type: 'acl.changed',
        object,
        payload: { objectId: this.loaded.object.id },
      })
    }
  }

  eventObject() {
    const { object } = this.loaded
    return { id: object.id, type: object.type, spaceId: object.spaceId, title: object.title }
  }

  /**
   * Наблюдатели ядра (ознакомление, ADR-0084): шаги их типов, у которых в этом
   * проходе изменились назначенные, решения или статус.
   */
  private async notifyObservers(
    previous: Map<string, StepRun>,
    after: InstanceState,
  ): Promise<void> {
    const entriesOf = (run: StepRun) =>
      run.entries.map((entry) => ({
        userId: entry.userId,
        state: entry.state,
        decidedAt: entry.decidedAt,
        actorId: entry.actorId,
      }))
    for (const observer of processObservers()) {
      for (const run of after.steps) {
        if (!observer.stepTypes.includes(run.type)) continue
        const old = previous.get(run.id)
        const entries = entriesOf(run)
        const before = old ? entriesOf(old) : null
        if (
          before &&
          old?.status === run.status &&
          JSON.stringify(before) === JSON.stringify(entries)
        ) {
          continue
        }
        await observer.stepChanged(this.tx, this.ctx, {
          instance: this.instanceInfo(),
          step: { id: run.id, key: run.key, type: run.type, status: run.status, dueAt: run.dueAt },
          entries,
          previous: before,
        })
      }
    }
  }

  /** Отменённый шаг модуля: модуль снимает свои поручения. */
  private async cancelModuleStep(run: StepRun): Promise<void> {
    const step = this.stepOf(run)
    if (step.type !== 'task' && step.type !== 'call' && step.type !== 'register') return
    const handler = processStepHandler(
      step.type,
      this.loaded.object.type,
      step.type === 'call' ? step.action : undefined,
    )
    await handler?.cancel?.(this.tx, this.ctx, {
      instance: this.instanceInfo(),
      step: this.stepInfo(run),
      params: step.type === 'register' ? { journal: step.journal ?? null } : step.params,
      actor: null,
      payload: {},
    })
  }

  /** Входящие: ждущему решения — элемент, ответившему или снятому — закрытие. */
  private async syncInbox(previous: Map<string, StepRun>, after: InstanceState): Promise<void> {
    for (const run of after.steps) {
      const kind = INBOX_KIND[run.type]
      if (!kind || !DECISIONS_BY_TYPE[run.type]) continue
      const step = this.stepOf(run)
      if (!isDecisionStep(step)) continue
      const old = previous.get(run.id)
      const wasPending = new Set(
        (old?.entries ?? [])
          .filter((entry) => entry.state === 'pending')
          .map((entry) => entry.userId),
      )
      const nowPending = new Set(
        run.entries.filter((entry) => entry.state === 'pending').map((entry) => entry.userId),
      )
      for (const entry of run.entries) {
        if (wasPending.has(entry.userId) && !nowPending.has(entry.userId)) {
          const decided = !['cancelled', 'delegated'].includes(entry.state)
          await InboxService.resolve(
            this.tx,
            this.ctx,
            { processStepId: run.id, userId: entry.userId },
            decided ? 'resolved' : 'dismissed',
            entry.state,
          )
          wasPending.delete(entry.userId)
        }
      }
      for (const userId of nowPending) {
        if (wasPending.has(userId)) continue
        await InboxService.open(this.tx, this.ctx, {
          userId,
          kind,
          objectId: this.loaded.object.id,
          processStepId: run.id,
          titleKey: `processes.inbox.${kind}`,
          dueAt: run.dueAt,
          dedupeKey: `process:${run.id}:${userId}`,
          payload: {
            instanceId: this.loaded.instance.id,
            stepKey: run.key,
            stepType: run.type,
          },
          actions: inboxActions(step),
        })
      }
    }
  }
}

/** Кнопки элемента Входящих по типу шага. */
function inboxActions(step: Step): InboxItem['actions'] {
  const action = (
    key: string,
    variant: InboxItem['actions'][number]['variant'],
    extra: Partial<InboxItem['actions'][number]> = {},
  ): InboxItem['actions'][number] => ({
    key,
    labelKey: `inbox.actions.${key}`,
    variant,
    requiresComment: false,
    requiresSecondFactor: false,
    ...extra,
  })
  switch (step.type) {
    case 'approval':
      return [
        action('approve', 'primary'),
        action('remarks', 'secondary', { requiresComment: true }),
        action('reject', 'danger', { requiresComment: true }),
      ]
    case 'sign':
      return [
        action('sign', 'primary', { requiresSecondFactor: step.requireMfa }),
        action('refuse', 'danger', { requiresComment: true }),
      ]
    case 'acknowledge':
      return [action('acknowledge', 'primary')]
    case 'register':
      return [action('register', 'primary')]
    case 'return':
      return [
        action('resubmit', 'primary'),
        action('withdraw', 'danger', { requiresComment: true }),
      ]
    default:
      return []
  }
}

/** Участники шагов (кроме получателей уведомлений) — ключ для сравнения составов. */
function participantsKey(state: InstanceState): string {
  const active = new Set<string>()
  const all = new Set<string>()
  for (const run of state.steps) {
    if (run.type === 'notify') continue
    for (const entry of run.entries) {
      all.add(entry.userId)
      if (run.status === 'active') active.add(entry.userId)
    }
  }
  return `${[...active].sort().join(',')}|${[...all].sort().join(',')}`
}
