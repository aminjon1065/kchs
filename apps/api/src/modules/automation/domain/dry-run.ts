import type { RuleDefinition, RuleDryRunItem, RuleDryRunResult } from '@kchs/contracts'
import { authorize } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { recentEvents } from '~/kernel/events/index.js'
import { config } from '~/shared/config/index.js'
import type { UserCtx } from '~/shared/context.js'
import { errors } from '~/shared/errors.js'
import { describeAction } from './actions.js'
import { objectScopeData } from './runner.js'
import { evaluateRuleCondition, ruleScope, scopeFromEvent } from './scope.js'
import { matchesFilter } from './subscribers.js'

/**
 * Тестовый прогон «что бы произошло» (contracts/automation-rule.md §Правила
 * исполнения): правило проверяется на последних событиях без выполнения
 * действий. Поля карточки читаются под правами служебного пользователя —
 * прогон не показывает того, чего правило не увидит при работе.
 */
export async function dryRun(
  ctx: UserCtx,
  definition: RuleDefinition,
  limit: number,
): Promise<RuleDryRunResult> {
  if (definition.trigger.kind !== 'event') {
    throw errors.validation('Тестовый прогон есть у правил с триггером по событию')
  }
  const runAs = definition.runAs ? await buildUserCtxFor(definition.runAs) : null
  const events = await recentEvents(definition.trigger.type, limit)
  const items: RuleDryRunItem[] = []

  for (const event of events) {
    const data = scopeFromEvent(event)
    const item: RuleDryRunItem = {
      eventId: event.id,
      eventType: event.type,
      occurredAt: event.occurredAt,
      objectId: event.object?.id ?? null,
      objectTitle: event.object?.title ?? null,
      matched: false,
      reason: null,
      actions: [],
    }

    if (!matchesFilter(event, definition.trigger.filter)) {
      item.reason = 'Не подходит по отбору события'
      items.push(item)
      continue
    }
    if (event.object && runAs) {
      const decision = await authorize(runAs, 'view', event.object.id, { soft: true })
      if (!decision.allowed) {
        item.reason = 'Служебный пользователь не видит объект'
        items.push(item)
        continue
      }
      data.object = await objectScopeData(event.object.id)
    }

    const scope = ruleScope(data, ctx.timezone || config().TZ)
    if (definition.conditions) {
      try {
        if (!evaluateRuleCondition(definition.conditions, scope)) {
          item.reason = 'Условие не выполнено'
          items.push(item)
          continue
        }
      } catch (error) {
        item.reason = `Условие не вычислено: ${error instanceof Error ? error.message : error}`
        items.push(item)
        continue
      }
    }

    item.matched = true
    item.actions = definition.actions.map((action) => {
      try {
        return { action: action.type, summary: describeAction(action, scope), problem: null }
      } catch (error) {
        return {
          action: action.type,
          summary: '',
          problem: error instanceof Error ? error.message : String(error),
        }
      }
    })
    items.push(item)
  }

  return {
    checked: items.length,
    matched: items.filter((item) => item.matched).length,
    items,
  }
}
