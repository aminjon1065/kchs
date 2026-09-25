import type {
  EventEnvelope,
  RuleBranch,
  RuleDefinition,
  RuleDryRunItem,
  RuleDryRunResult,
} from '@kchs/contracts'
import type { EvalScope } from '@kchs/query/expr'
import { and, desc, inArray, isNull } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { recentEvents } from '~/kernel/events/index.js'
import { config } from '~/shared/config/index.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { objects } from '~/shared/db/schema/index.js'
import { describeAction } from './actions.js'
import { buildScopeData, objectScopeData } from './runner.js'
import { checkMetricTrigger } from './schedules.js'
import { evaluateRuleCondition, type RuleScopeData, ruleScope, scopeFromEvent } from './scope.js'
import { matchesFilter } from './triggers.js'

/**
 * Тестовый прогон «что бы произошло» (contracts/automation-rule.md §Правила
 * исполнения): правило проверяется без выполнения действий. Поля карточки читаются
 * под правами служебного пользователя — прогон не показывает того, чего правило не
 * увидит при работе. Кроме событий (ADR-0163): расписание и показатель — один запуск
 * «сейчас», входящий вызов — последние вызовы с ключом правила, кнопка у объекта —
 * последние изменённые объекты нужных типов.
 */

type Decision = Pick<RuleDryRunItem, 'matched' | 'branch' | 'reason' | 'actions'>

const notMatched = (reason: string): Decision => ({
  matched: false,
  branch: null,
  reason,
  actions: [],
})

/** Условие и ветка: что сделало бы правило в этой области вычисления. */
function decide(definition: RuleDefinition, scope: EvalScope): Decision {
  let branch: RuleBranch = 'then'
  if (definition.conditions) {
    try {
      if (!evaluateRuleCondition(definition.conditions, scope)) {
        if (definition.otherwise.length === 0) return notMatched('Условие не выполнено')
        branch = 'otherwise'
      }
    } catch (error) {
      return notMatched(`Условие не вычислено: ${error instanceof Error ? error.message : error}`)
    }
  }
  const list = branch === 'otherwise' ? definition.otherwise : definition.actions
  return {
    matched: true,
    branch,
    reason: null,
    actions: list.map((action) => {
      try {
        return { action: action.type, summary: describeAction(action, scope), problem: null }
      } catch (error) {
        return {
          action: action.type,
          summary: '',
          problem: error instanceof Error ? error.message : String(error),
        }
      }
    }),
  }
}

function blankItem(
  id: string,
  type: string,
  occurredAt: string,
  object: { id: string; title: string | null } | null,
): RuleDryRunItem {
  return {
    eventId: id,
    eventType: type,
    occurredAt,
    objectId: object?.id ?? null,
    objectTitle: object?.title ?? null,
    matched: false,
    branch: null,
    reason: null,
    actions: [],
  }
}

/** Прогон по событиям: триггер «Событие» и входящий вызов (`webhook.received`). */
async function onEvents(
  definition: RuleDefinition,
  events: EventEnvelope[],
  runAs: UserCtx | null,
  timezone: string,
  filter: (event: EventEnvelope) => boolean,
): Promise<RuleDryRunItem[]> {
  const items: RuleDryRunItem[] = []
  for (const event of events) {
    const data = scopeFromEvent(event)
    const item = blankItem(event.id, event.type, event.occurredAt, event.object ?? null)
    if (!filter(event)) {
      items.push({ ...item, reason: 'Не подходит по отбору события' })
      continue
    }
    if (event.object && runAs) {
      const decision = await authorize(runAs, 'view', event.object.id, { soft: true })
      if (!decision.allowed) {
        items.push({ ...item, reason: 'Служебный пользователь не видит объект' })
        continue
      }
      data.object = await objectScopeData(event.object.id)
    }
    items.push({ ...item, ...decide(definition, ruleScope(data, timezone)) })
  }
  return items
}

/** Один запуск «сейчас» — расписание, показатель, кнопка у конкретного объекта. */
async function once(
  definition: RuleDefinition,
  runAs: UserCtx | null,
  timezone: string,
  input: { trigger: string; payload: Record<string, unknown>; actorId?: string | null },
  object: { id: string; title: string | null } | null,
): Promise<RuleDryRunItem> {
  const now = new Date().toISOString()
  const item = blankItem(`dry-run:${object?.id ?? 'now'}`, input.trigger, now, object)
  if (object && runAs) {
    const decision = await authorize(runAs, 'view', object.id, { soft: true })
    if (!decision.allowed) return { ...item, reason: 'Служебный пользователь не видит объект' }
  }
  const data: RuleScopeData = await buildScopeData(
    { trigger: input.trigger, runId: 'dry-run', payload: input.payload, actorId: input.actorId },
    object?.id ?? null,
  )
  return { ...item, ...decide(definition, ruleScope(data, timezone)) }
}

async function objectTitle(id: string): Promise<{ id: string; title: string | null }> {
  const data = await objectScopeData(id)
  return { id, title: (data?.title as string | undefined) ?? null }
}

export async function dryRun(
  ctx: UserCtx,
  definition: RuleDefinition,
  limit: number,
): Promise<RuleDryRunResult> {
  const runAs = definition.runAs ? await buildUserCtxFor(definition.runAs) : null
  const timezone = ctx.timezone || config().TZ
  const trigger = definition.trigger
  let items: RuleDryRunItem[] = []

  switch (trigger.kind) {
    case 'event':
      items = await onEvents(
        definition,
        await recentEvents(trigger.type, limit),
        runAs,
        timezone,
        (event) => matchesFilter(event, trigger.filter),
      )
      break
    case 'webhook': {
      // Вызовы с ключом правила — среди последних входящих вызовов платформы
      const calls = (await recentEvents('webhook.received', 100))
        .filter((event) => (event.payload as { hookKey?: unknown }).hookKey === trigger.hookKey)
        .slice(0, limit)
      items = await onEvents(definition, calls, runAs, timezone, () => true)
      break
    }
    case 'schedule':
      items = [
        await once(
          definition,
          runAs,
          timezone,
          { trigger: 'rule.schedule', payload: {} },
          trigger.objectId ? await objectTitle(trigger.objectId) : null,
        ),
      ]
      break
    case 'metric': {
      if (!runAs) {
        items = [
          {
            ...blankItem('dry-run:metric', 'rule.metric', new Date().toISOString(), null),
            reason: 'Служебный пользователь правила недоступен',
          },
        ]
        break
      }
      const visible = await authorize(runAs, 'view', trigger.metricId, { soft: true })
      if (!visible.allowed) {
        items = [
          {
            ...blankItem('dry-run:metric', 'rule.metric', new Date().toISOString(), null),
            reason: 'Служебный пользователь не видит показатель',
          },
        ]
        break
      }
      const checked = await checkMetricTrigger(runAs, trigger)
      const metric = await objectTitle(trigger.metricId)
      items = [
        checked.matched
          ? await once(
              definition,
              runAs,
              timezone,
              { trigger: 'rule.metric', payload: checked.payload },
              metric,
            )
          : {
              ...blankItem('dry-run:metric', 'rule.metric', new Date().toISOString(), metric),
              reason: checked.reason,
            },
      ]
      break
    }
    case 'manual': {
      // Последние изменённые объекты нужных типов, которые видит служебный пользователь
      const rows = await db()
        .select({ id: objects.id, title: objects.title })
        .from(objects)
        .where(and(inArray(objects.type, trigger.objectTypes), isNull(objects.deletedAt)))
        .orderBy(desc(objects.updatedAt))
        .limit(Math.min(limit * 3, 150))
      for (const row of rows) {
        if (items.length >= limit) break
        if (runAs && !(await authorize(runAs, 'view', row.id, { soft: true })).allowed) continue
        items.push(
          await once(
            definition,
            runAs,
            timezone,
            { trigger: 'rule.manual', payload: {}, actorId: ctx.userId },
            row,
          ),
        )
      }
      break
    }
  }

  return {
    checked: items.length,
    matched: items.filter((item) => item.matched).length,
    items,
  }
}
