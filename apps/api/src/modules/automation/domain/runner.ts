import type { EventEnvelope, RuleAction, RuleRunStep } from '@kchs/contracts'
import { RuleDefinition } from '@kchs/contracts'
import { evaluateCondition } from '@kchs/query/expr'
import { eq } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { directory } from '~/kernel/directory/port.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { processObjectProvider } from '~/kernel/process/registry.js'
import { config } from '~/shared/config/index.js'
import { type UserCtx, withCause } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { objects } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { type ActionContext, runAction } from './actions.js'
import { RuleService } from './rule-service.js'
import { RuleRuns } from './runs.js'
import { evaluateRuleCondition, type RuleScopeData, ruleScope, scopeFromEvent } from './scope.js'

/** Объект события есть в реестре: у людей и подразделений своей записи там нет. */
async function inRegistry(objectId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: objects.id })
    .from(objects)
    .where(eq(objects.id, objectId))
    .limit(1)
  return Boolean(row)
}

/**
 * Исполнение запуска правила (ADR-0096). Всё делается от имени служебного
 * пользователя (`run_as`): контекст собирается по нему, каждое действие
 * проходит `authorize`. Если `run_as` не видит объект события, запуск
 * пропускается — правило не должно уметь больше, чем человек.
 */

export interface RunOutcome {
  status: 'succeeded' | 'failed' | 'skipped' | 'waiting'
  reason?: string
}

/** Данные области вычисления для объекта: сводка реестра и поля карточки. */
export async function objectScopeData(objectId: string): Promise<Record<string, unknown> | null> {
  const summary = (await ObjectService.summaries([objectId])).get(objectId)
  if (!summary) return null
  const provider = processObjectProvider(summary.type)
  const data = await provider?.load(db(), objectId).catch(() => null)
  return {
    ...(data?.props ?? {}),
    id: summary.id,
    type: summary.type,
    title: summary.title,
    spaceId: summary.spaceId,
    ownerId: summary.ownerId,
    updatedAt: summary.updatedAt,
    meta: summary.meta,
    fields: data?.fields ?? {},
  }
}

/** Область вычисления запуска: событие, объект, инициатор, «сейчас». */
export async function buildScopeData(
  context: Record<string, unknown>,
  objectId: string | null,
): Promise<RuleScopeData> {
  const envelope = context.event as EventEnvelope | undefined
  const data: RuleScopeData = envelope
    ? scopeFromEvent(envelope)
    : {
        event: null,
        object: null,
        actor: {
          id: (context.actorId as string | null) ?? null,
          kind: 'system',
          displayName: null,
        },
        previous: {},
        now: new Date().toISOString(),
      }
  if (context.trigger) {
    // Данные запуска по расписанию, показателю или вызову — в `event.payload`
    data.event = {
      id: String(context.runId ?? ''),
      type: String(context.trigger),
      occurredAt: data.now,
      payload: (context.payload as Record<string, unknown>) ?? {},
      changedFields: null,
      correlationId: null,
    }
  }
  if (objectId) {
    // Объект события не всегда в реестре (человек, подразделение): тогда
    // остаётся то, что принёс конверт события, — идентификатор, вид и название
    data.object = (await objectScopeData(objectId)) ?? data.object
  }
  if (data.actor.id) {
    data.actor.displayName = (await directory().refs([data.actor.id])).get(data.actor.id)
      ? ((await directory().refs([data.actor.id])).get(data.actor.id)?.displayName ?? null)
      : null
  }
  return data
}

function step(
  index: number,
  action: RuleAction,
  status: RuleRunStep['status'],
  message: string,
  objectId: string | null,
  startedAt: number,
): RuleRunStep {
  return {
    index,
    action: action.type,
    status,
    message: message.slice(0, 1000),
    objectId,
    durationMs: Math.max(0, Date.now() - startedAt),
    at: new Date().toISOString(),
  }
}

/** Исполняет запуск: задание очереди `automation` вызывает эту функцию. */
export async function executeRun(runId: string): Promise<RunOutcome> {
  const run = await RuleRuns.load(runId)
  if (!run) return { status: 'skipped', reason: 'Запуск не найден' }
  if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'skipped') {
    return { status: run.status as RunOutcome['status'] }
  }

  const rule = await RuleService.load(db(), run.ruleId)
  if (!rule?.enabled) {
    await RuleRuns.finish(runId, 'skipped', { error: 'Правило выключено' })
    return { status: 'skipped', reason: 'Правило выключено' }
  }
  const definition = RuleDefinition.parse(rule.definition)

  await RuleRuns.start(runId)
  const base = definition.runAs ? await buildUserCtxFor(definition.runAs) : null
  if (!base) {
    const error = 'Служебный пользователь правила недоступен'
    await RuleRuns.fail(runId, rule.id, error, null)
    await RuleService.markRun(db(), rule.id, 'failed')
    return { status: 'failed', reason: error }
  }
  const ctx: UserCtx = {
    ...withCause(base, { eventId: run.eventId ?? runId, ruleId: rule.id }),
    requestId: `rule:${runId}`,
    sessionId: `rule:${rule.id}`,
  }

  const context = run.context as Record<string, unknown>
  const objectId = run.objectId
  // Доступ служебного пользователя к объекту события: без него не читаются и
  // поля карточки — правило не раскрывает того, чего не видит `run_as`.
  // Объект события не всегда объект реестра (`user.created` приносит человека,
  // `org.*` — подразделение): проверять у него видимость нечем и незачем —
  // права проверит само действие
  if (objectId && (await inRegistry(objectId))) {
    const decision = await authorize(ctx, 'view', objectId, { soft: true })
    if (!decision.allowed) {
      const reason = 'Служебный пользователь не видит объект события'
      await RuleRuns.finish(runId, 'skipped', { error: reason })
      await RuleService.markRun(db(), rule.id, 'skipped')
      return { status: 'skipped', reason }
    }
  }

  const data = await buildScopeData(context, objectId)
  const scope = ruleScope(data, config().TZ)

  if (definition.conditions && run.resumeAt === 0) {
    let matched = false
    try {
      matched = evaluateRuleCondition(definition.conditions, scope)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await RuleRuns.fail(runId, rule.id, `Условие не вычислено: ${message}`, null)
      await RuleService.markRun(db(), rule.id, 'failed')
      return { status: 'failed', reason: message }
    }
    if (!matched) {
      await RuleRuns.finish(runId, 'skipped', { error: 'Условие не выполнено' })
      await RuleService.markRun(db(), rule.id, 'skipped')
      return { status: 'skipped', reason: 'Условие не выполнено' }
    }
  }

  const actionContext: ActionContext = {
    ctx,
    ruleId: rule.id,
    runId,
    scope,
    data,
    objectId,
    spaceId: (data.object?.spaceId as string | null) ?? rule.spaceId,
  }

  for (let index = run.resumeAt; index < definition.actions.length; index++) {
    const action = definition.actions[index] as RuleAction
    const startedAt = Date.now()
    try {
      if (action.type === 'stop' && action.when && !evaluateCondition(action.when, scope)) {
        await RuleRuns.appendStep(
          runId,
          step(index, action, 'skipped', 'Условие остановки не выполнено', null, startedAt),
        )
        continue
      }
      const outcome = await runAction(action, actionContext)
      await RuleRuns.appendStep(
        runId,
        step(index, action, 'ok', outcome.message, outcome.objectId ?? null, startedAt),
      )
      if (outcome.waitMinutes) {
        const delayMs = outcome.waitMinutes * 60_000
        await RuleRuns.finish(runId, 'waiting', {
          resumeAt: index + 1,
          waitUntil: new Date(Date.now() + delayMs).toISOString(),
        })
        await RuleRuns.resume(runId, delayMs)
        return { status: 'waiting' }
      }
      if (outcome.stop) break
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await RuleRuns.appendStep(runId, step(index, action, 'failed', message, null, startedAt))
      await RuleRuns.fail(runId, rule.id, message, index)
      await RuleService.markRun(db(), rule.id, 'failed')
      return { status: 'failed', reason: message }
    }
  }

  await RuleRuns.finish(runId, 'succeeded')
  await RuleService.markRun(db(), rule.id, 'succeeded')
  logger().debug({ runId, ruleId: rule.id }, 'правило выполнено')
  return { status: 'succeeded' }
}
