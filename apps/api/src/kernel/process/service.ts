import type { RichBody } from '@kchs/contracts'
import {
  addStepAssignee,
  applyConditions,
  assigneeNodes,
  cancelProcess,
  completeStep,
  DECISIONS,
  type Decision,
  decideStep,
  delegateStep,
  initialState,
  isDecisionStep,
  type ProcessDefinition,
  ProcessDefinition as ProcessDefinitionSchema,
  parseAssignee,
  reassignStep,
  type StepRun,
  startProcess,
  stepAssigneeExpressions,
  type VariableType,
} from '@kchs/process'
import { and, eq } from 'drizzle-orm'
import { actorId, type Ctx, type UserCtx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { pgErrorCode, UNIQUE_VIOLATION } from '~/shared/db/pg-error.js'
import { processInstances, processStepActions } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { authorize, hasCapability, loadObject } from '../access/authorize.js'
import { AUDIT_ACTIONS, audit } from '../audit/service.js'
import { directory } from '../directory/port.js'
import { DiscussionService } from '../discussions/service.js'
import { publishEvent } from '../events/publisher.js'
import { delegationCovers } from '../inbox/service.js'
import { LinkService } from '../links/service.js'
import { objectType } from '../objects/registry.js'
import { confirmSecondFactor } from '../second-factor/port.js'
import { DefinitionService } from './definitions.js'
import {
  Execution,
  evaluate,
  evaluationData,
  INBOX_KIND,
  loadObjectData,
  transition,
} from './engine.js'
import { processObjectProvider, processStepHandler } from './registry.js'
import {
  type InstanceContext,
  instanceIdOfStep,
  type LoadedInstance,
  loadInstance,
} from './store.js'

/**
 * Экземпляры маршрутов (ADR-0079): запуск в транзакции вызывающего модуля,
 * решения назначенных (из Входящих, Telegram и API — одним путём), состав
 * назначенных, отмена, завершение шагов модулей. Каждый переход — под
 * блокировкой строки экземпляра, с событиями и аудитом решений.
 */

export interface StartProcessInput {
  objectId: string
  definitionKey?: string | undefined
  definitionId?: string | undefined
  variables?: Record<string, unknown> | undefined
  /** Выбор инициатора для шагов с `chosen_by_initiator`: ключ шага → сотрудники. */
  assignees?: Record<string, string[]> | undefined
}

export interface ActInput {
  stepId: string
  action: Decision
  comment?: string | null | undefined
  fileIds?: readonly string[] | undefined
  /** Код второго фактора для подписи с `requireMfa`. */
  code?: string | undefined
  /** Данные действия для модуля (номер вручную при регистрации). */
  payload?: Record<string, unknown> | undefined
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function field(path: string, message: string) {
  return { path, message }
}

/** Значения переменных по объявлениям определения: типы, обязательность, сотрудники. */
async function checkVariables(
  def: ProcessDefinition,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const problems: Array<{ path: string; message: string }> = []
  const out: Record<string, unknown> = {}
  for (const name of Object.keys(input)) {
    if (!def.variables[name]) problems.push(field(`variables.${name}`, 'Нет такой переменной'))
  }
  for (const [name, spec] of Object.entries(def.variables)) {
    const value = input[name]
    const empty =
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0)
    if (empty) {
      if (spec.required) problems.push(field(`variables.${name}`, 'Обязательная переменная'))
      continue
    }
    const problem = await checkValue(spec.type, value)
    if (problem) {
      problems.push(field(`variables.${name}`, problem))
      continue
    }
    out[name] = normalizeValue(spec.type, value)
  }
  if (problems.length > 0) throw errors.validation('Проверьте переменные маршрута', problems)
  return out
}

/** Идентификаторы — в нижнем регистре: так их хранит справочник. */
function normalizeValue(type: VariableType, value: unknown): unknown {
  if (type === 'user' || type === 'unit' || type === 'group') return String(value).toLowerCase()
  if (type === 'users') return (value as string[]).map((id) => id.toLowerCase())
  return value
}

async function checkValue(type: VariableType, value: unknown): Promise<string | null> {
  switch (type) {
    case 'user': {
      if (typeof value !== 'string' || !UUID.test(value)) return 'Нужен сотрудник'
      const active = await directory().activeUsers([value.toLowerCase()])
      return active.length === 1 ? null : 'Сотрудник не найден или отключён'
    }
    case 'users': {
      if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && UUID.test(id))) {
        return 'Нужен список сотрудников'
      }
      const ids = value.map((id: string) => id.toLowerCase())
      const active = await directory().activeUsers(ids)
      return active.length === new Set(ids).size ? null : 'Среди сотрудников есть отключённые'
    }
    case 'unit':
    case 'group':
      return typeof value === 'string' && UUID.test(value) ? null : 'Нужен идентификатор'
    case 'text':
      return typeof value === 'string' && value.length <= 2000 ? null : 'Нужен текст до 2000 знаков'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'Нужно число'
    case 'date':
      return typeof value === 'string' && ISO_DATE.test(value) ? null : 'Нужна дата ГГГГ-ММ-ДД'
    case 'boolean':
      return typeof value === 'boolean' ? null : 'Нужно да или нет'
  }
}

/** Выбор инициатора: только для шагов с `chosen_by_initiator`, обязателен там, где он единственный. */
async function checkChosen(
  def: ProcessDefinition,
  input: Record<string, string[]>,
): Promise<Record<string, string[]>> {
  const problems: Array<{ path: string; message: string }> = []
  const steps = new Map<string, readonly string[]>(
    Object.entries(def.steps).map(([key, step]) => [key, stepAssigneeExpressions(step)]),
  )
  def.conditions.forEach((condition, index) => {
    steps.set(condition.key ?? `cond_${index + 1}`, stepAssigneeExpressions(condition.step))
  })
  const choosing = new Map<string, boolean>()
  for (const [key, expressions] of steps) {
    const kinds = expressions.map((source) => {
      try {
        return assigneeNodes(parseAssignee(source)).map((node) => node.kind)
      } catch {
        return []
      }
    })
    if (kinds.some((list) => list.includes('chosen_by_initiator'))) {
      choosing.set(key, expressions.length === 1)
    }
  }
  const out: Record<string, string[]> = {}
  for (const [key, ids] of Object.entries(input)) {
    if (!choosing.has(key)) {
      problems.push(field(`assignees.${key}`, 'У шага нет выбора инициатора'))
      continue
    }
    const unique = [...new Set(ids.map((id) => id.toLowerCase()))]
    const active = await directory().activeUsers(unique)
    if (active.length !== unique.length) {
      problems.push(field(`assignees.${key}`, 'Среди сотрудников есть отключённые'))
    }
    out[key] = active
  }
  for (const [key, only] of choosing) {
    if (only && !out[key]?.length) {
      problems.push(field(`assignees.${key}`, 'Выберите исполнителей шага'))
    }
  }
  if (problems.length > 0) throw errors.validation('Проверьте выбор исполнителей', problems)
  return out
}

/** Тело сообщения-решения: абзацы комментария. */
function richText(text: string): RichBody {
  return {
    type: 'doc',
    content: text
      .split(/\n+/)
      .filter((line) => line.trim())
      .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
  }
}

async function lockByStep(tx: Executor, stepId: string): Promise<LoadedInstance> {
  const instanceId = await instanceIdOfStep(tx, stepId)
  if (!instanceId) throw errors.notFound('Шаг маршрута')
  return loadInstance(tx, instanceId, { lock: true })
}

async function prepared(tx: Executor, ctx: Ctx, loaded: LoadedInstance): Promise<Execution> {
  const execution = new Execution(tx, ctx, loaded)
  await execution.objectData()
  return execution
}

/**
 * Не участник шага, не видящий объект, получает 404: существование маршрута
 * и шага не раскрывается (17-security.md §3). Участнику ответит модель
 * («очередь не дошла», «решение уже принято»).
 */
async function assertParticipant(
  ctx: UserCtx,
  loaded: LoadedInstance,
  run: StepRun,
  userId: string,
): Promise<void> {
  if (run.entries.some((entry) => entry.userId === userId)) return
  await authorize(ctx, 'view', loaded.object.id)
}

/** Замещающий действует в пределах области замещения (как копии Входящих). */
function assertActingFor(ctx: UserCtx, run: StepRun): void {
  if (!ctx.onBehalfOf) return
  const delegation = ctx.principals.actingFor.find((item) => item.userId === ctx.onBehalfOf)
  const kind = INBOX_KIND[run.type]
  if (!delegation || !kind || !delegationCovers(kind, delegation.scope)) {
    throw errors.forbidden('Замещение не распространяется на этот шаг', {
      reason: 'delegation_scope',
    })
  }
}

async function recordAction(
  tx: Executor,
  ctx: UserCtx,
  stepId: string,
  action: string,
  comment: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.insert(processStepActions).values({
    id: newId(),
    stepId,
    actorId: ctx.userId,
    onBehalfOf: ctx.onBehalfOf,
    action,
    comment,
    payload,
  })
}

export const ProcessService = {
  /**
   * Запуск маршрута для объекта в транзакции вызывающего модуля: опубликованная
   * версия определения, переменные и выбор инициатора, условия запуска.
   * Права проверяет вызывающий (модуль или `POST /processes`).
   */
  async start(tx: Executor, ctx: Ctx, input: StartProcessInput): Promise<{ instanceId: string }> {
    const object = await loadObject(input.objectId, tx)
    if (!object || object.deletedAt) throw errors.notFound()
    const definition = await DefinitionService.published(tx, {
      key: input.definitionKey,
      id: input.definitionId,
    })
    if (definition.objectType !== object.type) {
      throw errors.validation('Маршрут предназначен для объектов другого типа')
    }
    const base = ProcessDefinitionSchema.parse(definition.definition)
    const [running] = await tx
      .select({ id: processInstances.id })
      .from(processInstances)
      .where(
        and(
          eq(processInstances.objectId, object.id),
          eq(processInstances.definitionKey, definition.key),
          eq(processInstances.status, 'running'),
        ),
      )
      .limit(1)
    if (running) throw errors.conflict('Маршрут для объекта уже идёт', { instanceId: running.id })

    const variables = await checkVariables(base, input.variables ?? {})
    const chosen = await checkChosen(base, input.assignees ?? {})
    const data = await loadObjectData(tx, object)
    const authorUnit =
      data.authorUnitId !== undefined
        ? data.authorUnitId
        : data.authorId
          ? await directory().primaryUnit(data.authorId)
          : null
    const initiatorId = actorId(ctx)
    const scope = evaluationData(object, data, variables, initiatorId, authorUnit)
    const applied = base.conditions
      .map((condition, index) => (evaluate(condition.if, { ...scope }) ? index : -1))
      .filter((index) => index >= 0)
    const context: InstanceContext = {
      variables,
      chosen,
      conditions: applied,
      round: 1,
      seq: 0,
      reapproval: 'full',
      cancelReason: null,
    }

    const instanceId = newId()
    try {
      await tx.transaction(async (savepoint) => {
        await savepoint.insert(processInstances).values({
          id: instanceId,
          definitionId: definition.id,
          definitionKey: definition.key,
          objectId: object.id,
          status: 'running',
          context: context as unknown as Record<string, unknown>,
          startedBy: initiatorId,
        })
      })
    } catch (error) {
      if (pgErrorCode(error) === UNIQUE_VIOLATION) {
        throw errors.conflict('Маршрут для объекта уже идёт')
      }
      throw error
    }
    const [instance] = await tx
      .select()
      .from(processInstances)
      .where(eq(processInstances.id, instanceId))
      .limit(1)
    if (!instance) throw errors.internal('Маршрут не создан')

    await publishEvent(tx, ctx, {
      type: 'process.started',
      object: { id: object.id, type: object.type, spaceId: object.spaceId, title: object.title },
      payload: {
        instanceId,
        definitionKey: definition.key,
        version: definition.version,
        name: base.name.ru,
      },
    })

    const def = applyConditions(base, applied)
    const loaded: LoadedInstance = {
      instance,
      version: definition.version,
      base,
      def,
      context,
      state: initialState(),
      meta: new Map(),
      object,
    }
    const execution = await prepared(tx, ctx, loaded)
    await execution.apply(transition(() => startProcess(def, execution.env())))
    // Решать некому уже на старте — ошибка настройки: маршрут не запускается
    const orphan = execution.state.steps.find((run) => {
      const step = def.steps[run.key]
      return (
        run.status === 'active' &&
        run.resolved &&
        run.entries.length === 0 &&
        step !== undefined &&
        isDecisionStep(step)
      )
    })
    if (orphan) {
      const name = def.steps[orphan.key]?.name?.ru ?? orphan.key
      throw errors.validation(`Не удалось определить назначенных шага «${name}»`, [
        { path: `steps.${orphan.key}`, message: 'Никто не назначен', code: 'no_assignees' },
      ])
    }
    await execution.commit()
    return { instanceId }
  },

  /** Решение шага: согласовать, замечания, отклонить, подписать, ознакомиться… */
  async act(tx: Executor, ctx: UserCtx, input: ActInput): Promise<void> {
    if (!DECISIONS.includes(input.action)) throw errors.validation('Нет такого действия')
    const loaded = await lockByStep(tx, input.stepId)
    const execution = await prepared(tx, ctx, loaded)
    const run = execution.run(input.stepId)
    const step = execution.stepOf(run)
    const entryUser = ctx.onBehalfOf ?? ctx.userId
    await assertParticipant(ctx, loaded, run, entryUser)
    assertActingFor(ctx, run)
    const comment = input.comment?.trim() || null
    const fileIds = [...new Set(input.fileIds ?? [])]

    if ((input.action === 'reject' || input.action === 'refuse') && !comment) {
      throw errors.validation('Укажите причину в комментарии', [
        { path: 'comment', message: 'Нужен комментарий' },
      ])
    }
    if (input.action === 'remarks' && !comment && fileIds.length === 0) {
      throw errors.validation('Опишите замечания или приложите файл', [
        { path: 'comment', message: 'Нужен комментарий или файл' },
      ])
    }
    const pending = run.entries.some(
      (entry) => entry.userId === entryUser && entry.state === 'pending',
    )
    let mfa = false
    let result: Record<string, unknown> | undefined
    if (pending && run.status === 'active') {
      if (step.type === 'sign' && step.requireMfa && input.action === 'sign') {
        // Код вводит тот, кто действует, — при замещении заместитель
        await confirmSecondFactor(ctx.userId, input.code)
        mfa = true
      }
      if (step.type === 'register' && input.action === 'register') {
        const handler = processStepHandler('register', loaded.object.type)
        if (!handler) {
          throw errors.conflict(`Нет исполнителя регистрации для типа «${loaded.object.type}»`)
        }
        const outcome = await handler.execute(tx, ctx, {
          instance: execution.instanceInfo(),
          step: execution.stepInfo(run),
          params: { journal: step.journal ?? null },
          actor: { userId: ctx.userId, onBehalfOf: ctx.onBehalfOf },
          payload: input.payload ?? {},
        })
        if (outcome !== 'wait') result = outcome.result
      }
    }

    const next = transition(() =>
      decideStep(
        loaded.def,
        loaded.state,
        {
          stepId: run.id,
          userId: entryUser,
          decision: input.action,
          actorId: ctx.userId,
          ...(result ? { result } : {}),
        },
        execution.env(),
      ),
    )

    await recordAction(tx, ctx, run.id, input.action, comment, {
      fileIds,
      ...(mfa ? { mfa: true } : {}),
      ...(result ? { result } : {}),
    })
    await ProcessService.attachDecision(tx, ctx, loaded, comment, fileIds)
    await publishEvent(tx, ctx, {
      type: 'process.step_decided',
      object: execution.eventObject(),
      payload: {
        instanceId: loaded.instance.id,
        stepId: run.id,
        stepKey: run.key,
        kind: run.type,
        decision: input.action,
        userId: entryUser,
      },
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.processDecision,
        objectId: loaded.object.id,
        objectType: loaded.object.type,
        details: {
          instanceId: loaded.instance.id,
          stepId: run.id,
          stepKey: run.key,
          decision: input.action,
          userId: entryUser,
          ...(mfa ? { mfa: true } : {}),
        },
      },
      tx,
    )
    const decided = next.state.steps.find((item) => item.id === run.id) ?? run
    await processObjectProvider(loaded.object.type)?.onDecision?.(tx, ctx, {
      instance: execution.instanceInfo(),
      step: execution.stepInfo(decided),
      decision: {
        userId: entryUser,
        actorId: ctx.userId,
        onBehalfOf: ctx.onBehalfOf,
        action: input.action,
        comment,
        fileIds,
      },
    })
    await execution.apply(next)
    await execution.commit()
  },

  /**
   * Комментарий и файлы решения — сообщение `decision` в обсуждении объекта
   * (02-platform-kernel.md §6): автор видит замечания там же, где обсуждение;
   * файлы становятся вложениями объекта (прикрепить можно только свой файл).
   */
  async attachDecision(
    tx: Executor,
    ctx: UserCtx,
    loaded: LoadedInstance,
    comment: string | null,
    fileIds: readonly string[],
  ): Promise<void> {
    if (!comment && fileIds.length === 0) return
    const object = loaded.object
    if (objectType(object.type)?.discussable) {
      const conversationId = await DiscussionService.ensureObjectConversation(tx, ctx, object.id)
      await DiscussionService.post(
        tx,
        ctx,
        conversationId,
        {
          body: richText(comment ?? ''),
          text: comment ?? '',
          attachments: fileIds.map((fileId) => ({ fileId })),
          mentions: [],
          mentionedObjectIds: [],
        },
        'decision',
      )
      return
    }
    for (const fileId of fileIds) {
      await authorize(ctx, 'share', fileId)
      await LinkService.link(tx, ctx, object.id, fileId, 'attachment')
    }
  },

  /** Добавить согласующего (шаг разрешает): добавляет ждущий решения согласующий. */
  async addAssignee(
    tx: Executor,
    ctx: UserCtx,
    input: { stepId: string; userId: string; comment?: string | null | undefined },
  ): Promise<void> {
    await ProcessService.changeAssignees(tx, ctx, input.stepId, 'added', async (execution, run) => {
      const [userId] = await directory().activeUsers([input.userId.toLowerCase()])
      if (!userId) throw errors.validation('Сотрудник не найден или отключён')
      const next = transition(() =>
        addStepAssignee(
          execution.loaded.def,
          execution.loaded.state,
          { stepId: run.id, byUserId: ctx.onBehalfOf ?? ctx.userId, userId },
          execution.env(),
        ),
      )
      await recordAction(tx, ctx, run.id, 'add_approver', input.comment?.trim() || null, {
        userId,
      })
      return { next, added: [userId], removed: [] }
    })
  },

  /** Передать свой шаг другому сотруднику (шаг разрешает). */
  async delegate(
    tx: Executor,
    ctx: UserCtx,
    input: { stepId: string; userId: string; comment?: string | null | undefined },
  ): Promise<void> {
    await ProcessService.changeAssignees(
      tx,
      ctx,
      input.stepId,
      'delegated',
      async (execution, run) => {
        const [userId] = await directory().activeUsers([input.userId.toLowerCase()])
        if (!userId) throw errors.validation('Сотрудник не найден или отключён')
        const from = ctx.onBehalfOf ?? ctx.userId
        const next = transition(() =>
          delegateStep(
            execution.loaded.def,
            execution.loaded.state,
            { stepId: run.id, fromUserId: from, toUserId: userId },
            execution.env(),
          ),
        )
        await recordAction(tx, ctx, run.id, 'delegate', input.comment?.trim() || null, {
          userId,
        })
        return { next, added: [userId], removed: [from] }
      },
    )
  },

  /** Переназначение администратором маршрутов: замена назначенного или назначение пустого шага. */
  async reassign(
    tx: Executor,
    ctx: UserCtx,
    input: { stepId: string; fromUserId: string | null; userIds: string[] },
  ): Promise<void> {
    if (!hasCapability(ctx, 'processes.manage')) {
      throw errors.forbidden('Требуется способность', { capability: 'processes.manage' })
    }
    await ProcessService.changeAssignees(
      tx,
      ctx,
      input.stepId,
      'reassigned',
      async (execution, run) => {
        const ids = [...new Set(input.userIds.map((id) => id.toLowerCase()))]
        const active = await directory().activeUsers(ids)
        if (active.length !== ids.length)
          throw errors.validation('Среди сотрудников есть отключённые')
        const next = transition(() =>
          reassignStep(
            execution.loaded.def,
            execution.loaded.state,
            { stepId: run.id, fromUserId: input.fromUserId, userIds: active },
            execution.env(),
          ),
        )
        await recordAction(tx, ctx, run.id, 'reassign', null, {
          fromUserId: input.fromUserId,
          userIds: active,
        })
        await audit(
          ctx,
          {
            action: AUDIT_ACTIONS.processReassigned,
            objectId: execution.loaded.object.id,
            objectType: execution.loaded.object.type,
            details: { stepId: run.id, fromUserId: input.fromUserId, userIds: active },
            severity: 'notice',
          },
          tx,
        )
        return { next, added: active, removed: input.fromUserId ? [input.fromUserId] : [] }
      },
    )
  },

  async changeAssignees(
    tx: Executor,
    ctx: UserCtx,
    stepId: string,
    reason: 'added' | 'delegated' | 'reassigned',
    change: (
      execution: Execution,
      run: StepRun,
    ) => Promise<{
      next: ReturnType<typeof transition>
      added: string[]
      removed: string[]
    }>,
  ): Promise<void> {
    const loaded = await lockByStep(tx, stepId)
    const execution = await prepared(tx, ctx, loaded)
    const run = execution.run(stepId)
    if (reason !== 'reassigned') {
      await assertParticipant(ctx, loaded, run, ctx.onBehalfOf ?? ctx.userId)
      assertActingFor(ctx, run)
    }
    const { next, added, removed } = await change(execution, run)
    await publishEvent(tx, ctx, {
      type: 'process.step_assignees_changed',
      object: execution.eventObject(),
      payload: {
        instanceId: loaded.instance.id,
        stepId: run.id,
        stepKey: run.key,
        kind: run.type,
        added,
        removed,
        reason,
      },
    })
    await execution.apply(next)
    await execution.commit()
  },

  /**
   * Отмена маршрута: инициатор, управляющий объектом или администратор
   * маршрутов; системный контекст (корзина объекта) — без проверки.
   */
  async cancel(
    tx: Executor,
    ctx: Ctx,
    input: { instanceId: string; reason?: string | null | undefined; outcome?: string },
  ): Promise<void> {
    const loaded = await loadInstance(tx, input.instanceId, { lock: true })
    if (ctx.kind === 'user') {
      // Маршрут невидимого объекта не раскрывается
      await authorize(ctx, 'view', loaded.object.id)
      const allowed =
        loaded.instance.startedBy === ctx.userId ||
        hasCapability(ctx, 'processes.manage') ||
        (await authorize(ctx, 'manage', loaded.object.id, { soft: true })).allowed
      if (!allowed)
        throw errors.forbidden('Отменить маршрут может инициатор или управляющий объектом')
    }
    const execution = await prepared(tx, ctx, loaded)
    const next = transition(() =>
      cancelProcess(
        loaded.def,
        loaded.state,
        { outcome: input.outcome ?? 'cancelled' },
        execution.env(),
      ),
    )
    loaded.context.cancelReason = input.reason?.trim() || null
    await execution.apply(next)
    await execution.commit()
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.processCancelled,
        objectId: loaded.object.id,
        objectType: loaded.object.type,
        details: { instanceId: loaded.instance.id, reason: loaded.context.cancelReason },
        severity: 'notice',
      },
      tx,
    )
  },

  /**
   * Завершение шага модулем: поручение шага `task` исполнено, асинхронное
   * действие `call` выполнено. Шаги решения завершаются только решениями.
   */
  async completeStep(
    tx: Executor,
    ctx: Ctx,
    input: { stepId: string; outcome?: string; result?: Record<string, unknown> },
  ): Promise<void> {
    const loaded = await lockByStep(tx, input.stepId)
    const execution = await prepared(tx, ctx, loaded)
    const next = transition(() =>
      completeStep(
        loaded.def,
        loaded.state,
        {
          stepId: input.stepId,
          ...(input.outcome ? { outcome: input.outcome } : {}),
          ...(input.result ? { result: input.result } : {}),
        },
        execution.env(),
      ),
    )
    await execution.apply(next)
    await execution.commit()
  },

  /** Идущие маршруты объекта — для модулей (статус документа, запрет правки). */
  async running(
    tx: Executor,
    objectId: string,
  ): Promise<Array<{ instanceId: string; definitionKey: string }>> {
    const rows = await tx
      .select({ instanceId: processInstances.id, definitionKey: processInstances.definitionKey })
      .from(processInstances)
      .where(and(eq(processInstances.objectId, objectId), eq(processInstances.status, 'running')))
    return rows
  },
}
