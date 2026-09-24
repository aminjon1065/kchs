import type { EventEnvelope, RuleDefinition } from '@kchs/contracts'
import { RuleDefinition as RuleDefinitionSchema } from '@kchs/contracts'
import type { Subscriber } from '~/kernel/events/index.js'
import { NotificationService } from '~/kernel/notifications/service.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { logger } from '~/shared/logger/index.js'
import { type RuleRow, RuleService } from './rule-service.js'
import { RuleRuns } from './runs.js'
import { matchesTrigger } from './triggers.js'

/**
 * Подписчик правил (ADR-0096): каждое событие шины сверяется с включёнными
 * правилами триггера `event`. Совпавшее правило ставится в очередь
 * `automation` отдельным запуском — исполнение не задерживает шину.
 *
 * Защита от циклов: правило не запускается от событий, которые породило само,
 * а цепочка «событие → правило → событие» обрывается на глубине пяти звеньев.
 */
export const MAX_CAUSAL_DEPTH = 5

/**
 * Ставит запуск правила по событию, соблюдая лимит в час. Ключ повтора проверяет
 * исполнитель после условий: запуск, отсеянный условием, ключ не занимает.
 */
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
        // Список включённых правил читается на каждое событие: кэш с временем
        // жизни пропускал бы события, пришедшие сразу после создания правила
        const rules = await RuleService.enabledEventRules()
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
