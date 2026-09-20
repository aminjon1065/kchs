import type { EventEnvelope, RuleDefinition } from '@kchs/contracts'
import { RuleDefinition as RuleDefinitionSchema } from '@kchs/contracts'
import { matchesType } from '~/kernel/events/bus.js'
import type { Subscriber } from '~/kernel/events/index.js'
import { NotificationService } from '~/kernel/notifications/service.js'
import { config } from '~/shared/config/index.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { logger } from '~/shared/logger/index.js'
import { type RuleRow, RuleService } from './rule-service.js'
import { RuleRuns } from './runs.js'
import { renderTemplate, ruleScope, scopeFromEvent } from './scope.js'

/**
 * Подписчик правил (ADR-0096): каждое событие шины сверяется с включёнными
 * правилами триггера `event`. Совпавшее правило ставится в очередь
 * `automation` отдельным запуском — исполнение не задерживает шину.
 *
 * Защита от циклов: правило не запускается от событий, которые породило само,
 * а цепочка «событие → правило → событие» обрывается на глубине пяти звеньев.
 */
export const MAX_CAUSAL_DEPTH = 5

/** Кэш включённых правил: список меняется редко, а событий много. */
const CACHE_TTL_MS = 10_000
let cache: { rules: RuleRow[]; at: number } | null = null

export function invalidateRuleCache(): void {
  cache = null
}

async function eventRules(): Promise<RuleRow[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rules
  const rules = await RuleService.enabledEventRules()
  cache = { rules, at: Date.now() }
  return rules
}

function valueAt(event: EventEnvelope, path: string): unknown {
  let current: unknown = event
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/** Отбор по полям конверта: сравнение по значению, без вычисления выражений. */
export function matchesFilter(event: EventEnvelope, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([path, expected]) => {
    const actual = valueAt(event, path)
    if (Array.isArray(expected)) return expected.some((item) => String(item) === String(actual))
    if (expected === null) return actual === null || actual === undefined
    return String(expected) === String(actual)
  })
}

export function matchesTrigger(definition: RuleDefinition, event: EventEnvelope): boolean {
  if (definition.trigger.kind !== 'event') return false
  if (!matchesType([definition.trigger.type], event.type)) return false
  return matchesFilter(event, definition.trigger.filter)
}

/** Ставит запуск правила по событию, соблюдая лимиты и дедупликацию. */
export async function queueEventRun(
  rule: RuleRow,
  definition: RuleDefinition,
  event: EventEnvelope,
  depth: number,
): Promise<string | null> {
  if (!(await RuleRuns.withinLimit(rule.id, definition.limits.maxRunsPerHour))) {
    await RuleRuns.recordSkip(rule.id, {
      triggerKind: 'event',
      reason: `Превышен лимит ${definition.limits.maxRunsPerHour} запусков в час`,
      eventId: event.id,
    })
    return null
  }
  if (definition.limits.dedupeKey) {
    const scope = ruleScope(scopeFromEvent(event), config().TZ)
    const key = renderTemplate(definition.limits.dedupeKey, scope).trim()
    if (key.length > 0) {
      const claimed = await RuleRuns.claimDedupe(
        rule.id,
        key,
        definition.limits.dedupeWindowMinutes,
      )
      if (!claimed) {
        await RuleRuns.recordSkip(rule.id, {
          triggerKind: 'event',
          reason: `Повтор по ключу «${key}»`,
          eventId: event.id,
        })
        return null
      }
    }
  }

  return db().transaction((tx) =>
    RuleRuns.queue(tx, systemCtx('automation.rule', { initiatorId: event.actor.userId }), {
      ruleId: rule.id,
      triggerKind: 'event',
      eventId: event.id,
      eventType: event.type,
      objectId: event.object?.id ?? null,
      runAs: definition.runAs,
      depth,
      context: { event: event as unknown as Record<string, unknown> },
    }),
  )
}

export function automationSubscribers(): Subscriber[] {
  return [
    {
      name: 'automation-rules',
      types: ['*'],
      handle: async (event) => {
        // События самих правил меняют состав: кэш сбрасывается сразу
        if (event.type.startsWith('rule.')) invalidateRuleCache()
        const rules = await eventRules()
        if (rules.length === 0) return
        const candidates: Array<{ rule: RuleRow; definition: RuleDefinition }> = []
        for (const rule of rules) {
          const definition = RuleDefinitionSchema.parse(rule.definition)
          if (matchesTrigger(definition, event)) candidates.push({ rule, definition })
        }
        if (candidates.length === 0) return

        const chain = await RuleRuns.causalChain(event)
        for (const { rule, definition } of candidates) {
          if (chain.ruleIds.includes(rule.id)) {
            logger().debug({ ruleId: rule.id, eventId: event.id }, 'правило не идёт от себя')
            continue
          }
          if (chain.depth >= MAX_CAUSAL_DEPTH) {
            await RuleRuns.recordSkip(rule.id, {
              triggerKind: 'event',
              reason: `Цепочка правил длиннее ${MAX_CAUSAL_DEPTH} звеньев`,
              eventId: event.id,
            })
            continue
          }
          await queueEventRun(rule, definition, event, chain.depth)
        }
      },
    },
    {
      // Входящий вызов: правила с триггером `webhook` и тем же ключом
      name: 'automation-webhooks',
      types: ['webhook.received'],
      handle: async (event) => {
        const hookKey = String(event.payload.hookKey ?? '')
        if (!hookKey) return
        for (const rule of await RuleService.byHookKey(hookKey)) {
          const { runFromWebhook } = await import('./schedules.js')
          await runFromWebhook(rule, event.payload.body ?? {}, String(event.payload.source ?? ''))
        }
      },
    },
    {
      // Сбой правила — уведомление владельцу: он отвечает за правило
      name: 'automation-failures',
      types: ['rule.run_failed'],
      handle: async (event) => {
        const ruleId = event.payload.ruleId as string
        const rule = await RuleService.load(db(), ruleId)
        if (!rule?.ownerId) return
        await NotificationService.notify({
          userIds: [rule.ownerId],
          category: 'system',
          titleKey: 'notifications.tpl.ruleFailed',
          params: { title: rule.title, error: String(event.payload.error ?? '') },
          objectId: ruleId,
          url: `/automation/rules/${ruleId}`,
        })
      },
    },
  ]
}
