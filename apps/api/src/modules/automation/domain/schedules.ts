import { type MetricTrigger, RuleDefinition } from '@kchs/contracts'
import { evaluateCondition } from '@kchs/query/expr'
import { and, eq, isNull } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { queue } from '~/kernel/jobs/service.js'
import type { EntityScheduleEntry, EntityScheduleProvider } from '~/kernel/schedules/index.js'
import { Metrics } from '~/modules/data/public.js'
import { config } from '~/shared/config/index.js'
import { systemCtx, type UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { objects, rules } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { type RuleRow, RuleService } from './rule-service.js'
import { RuleRuns } from './runs.js'

/**
 * Расписания правил в едином планировщике (14-automation-integrations.md §2):
 * у каждого включённого правила с триггером `schedule` или `metric` — своё
 * повторяемое задание BullMQ в очереди `automation`. Состояние ведёт само
 * правило: выключили правило — планировщик снят.
 */
export const RULE_SCHEDULE_JOB = { queue: 'automation', name: 'rule.scheduled' } as const

// Без «:» — иначе BullMQ читает ключ как запись старого формата
const PREFIX = 'rule-'
const schedulerId = (ruleId: string) => `${PREFIX}${ruleId}`

const SCHEDULED_KINDS = ['schedule', 'metric']

/** Приводит планировщик правила к его состоянию. */
export async function syncRuleSchedule(ruleId: string): Promise<void> {
  const row = await RuleService.load(db(), ruleId)
  const automation = queue(RULE_SCHEDULE_JOB.queue)
  if (!row?.enabled || !row.cron || !SCHEDULED_KINDS.includes(row.triggerKind)) {
    await automation.removeJobScheduler(schedulerId(ruleId))
    return
  }
  await automation.upsertJobScheduler(
    schedulerId(ruleId),
    { pattern: row.cron, tz: row.timezone ?? config().TZ },
    {
      name: RULE_SCHEDULE_JOB.name,
      data: { ruleId },
      opts: { attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
    },
  )
}

/** При старте воркера: планировщики всех правил по расписанию, лишние — снять. */
export async function syncRuleSchedules(): Promise<number> {
  const rows = await db()
    .select({ id: rules.id })
    .from(rules)
    .innerJoin(objects, eq(objects.id, rules.id))
    .where(and(eq(rules.enabled, true), isNull(objects.deletedAt)))
  const wanted = new Set<string>()
  for (const row of rows) {
    const rule = await RuleService.load(db(), row.id)
    if (!rule?.cron || !SCHEDULED_KINDS.includes(rule.triggerKind)) continue
    wanted.add(row.id)
    await syncRuleSchedule(row.id)
  }
  const automation = queue(RULE_SCHEDULE_JOB.queue)
  for (const scheduler of await automation.getJobSchedulers(0, -1)) {
    const key = scheduler.key ?? scheduler.id
    if (typeof key !== 'string' || !key.startsWith(PREFIX)) continue
    if (!wanted.has(key.slice(PREFIX.length))) await automation.removeJobScheduler(key)
  }
  return wanted.size
}

/**
 * Значение показателя триггера под правами служебного пользователя и условие над ним: общее
 * для срабатывания по расписанию и тестового прогона (ADR-0163).
 */
export async function checkMetricTrigger(
  ctx: UserCtx,
  trigger: MetricTrigger,
): Promise<{ matched: boolean; reason: string; payload: Record<string, unknown> }> {
  const metric = await Metrics.get(trigger.metricId)
  const value = await Metrics.value(ctx, metric, {})
  const scope = {
    resolve: (path: readonly string[]) => {
      if (path[0] === 'value') return value.value
      if (path[0] === 'previous') return value.base
      if (path[0] === 'metric') return path[1] ? (value as never)[path[1] as never] : value.name
      return undefined
    },
  }
  const matched = evaluateCondition(trigger.condition, scope)
  return {
    matched,
    reason: matched ? '' : `Условие показателя не выполнено (${value.value ?? '—'})`,
    payload: { metricId: metric.id, name: value.name, value: value.value, base: value.base },
  }
}

/**
 * Срабатывание правила по расписанию. Для триггера `metric` значение
 * показателя считается под правами служебного пользователя и проверяется
 * условием: не выполнено — запуск не ставится.
 */
export async function fireScheduledRule(ruleId: string): Promise<string | null> {
  const rule = await RuleService.load(db(), ruleId)
  if (!rule?.enabled) {
    await syncRuleSchedule(ruleId)
    return null
  }
  const definition = RuleDefinition.parse(rule.definition)
  if (!(await RuleRuns.withinLimit(ruleId, definition.limits.maxRunsPerHour))) {
    await RuleRuns.recordSkip(ruleId, {
      triggerKind: definition.trigger.kind,
      reason: `Превышен лимит ${definition.limits.maxRunsPerHour} запусков в час`,
    })
    return null
  }

  let payload: Record<string, unknown> = {}
  let objectId: string | null = null

  if (definition.trigger.kind === 'metric') {
    const ctx = definition.runAs ? await buildUserCtxFor(definition.runAs) : null
    if (!ctx) {
      await RuleRuns.recordSkip(ruleId, {
        triggerKind: 'metric',
        reason: 'Служебный пользователь правила недоступен',
      })
      return null
    }
    const decision = await authorize(ctx, 'view', definition.trigger.metricId, { soft: true })
    if (!decision.allowed) {
      await RuleRuns.recordSkip(ruleId, {
        triggerKind: 'metric',
        reason: 'Служебный пользователь не видит показатель',
      })
      return null
    }
    const checked = await checkMetricTrigger(ctx, definition.trigger)
    if (!checked.matched) {
      await RuleRuns.recordSkip(ruleId, { triggerKind: 'metric', reason: checked.reason })
      return null
    }
    payload = checked.payload
    objectId = definition.trigger.metricId
  } else if (definition.trigger.kind === 'schedule') {
    objectId = definition.trigger.objectId
  }

  return db().transaction((tx) =>
    RuleRuns.queue(tx, systemCtx('automation.schedule'), {
      ruleId,
      triggerKind: definition.trigger.kind,
      objectId,
      runAs: definition.runAs,
      context: { trigger: `rule.${definition.trigger.kind}`, payload },
    }),
  )
}

/** Ручной запуск правила у объекта (триггер `manual`). */
export async function runManually(
  ctx: UserCtx,
  rule: RuleRow,
  objectId: string | null,
): Promise<string> {
  const definition = RuleDefinition.parse(rule.definition)
  if (definition.trigger.kind !== 'manual') {
    throw errors.validation('У правила нет ручного запуска')
  }
  if (!rule.enabled) throw errors.validation('Правило выключено')
  if (objectId) {
    // Запускающий должен видеть объект сам: кнопка не обходит доступ
    await authorize(ctx, 'view', objectId)
  }
  const runId = await db().transaction((tx) =>
    RuleRuns.queue(tx, ctx, {
      ruleId: rule.id,
      triggerKind: 'manual',
      objectId,
      runAs: definition.runAs,
      context: { trigger: 'rule.manual', actorId: ctx.userId, payload: {} },
    }),
  )
  if (!runId) throw errors.conflict('Запуск уже идёт')
  return runId
}

/** Входящий вызов правила: событие `webhook.received` ставит запуск. */
export async function runFromWebhook(
  rule: RuleRow,
  body: unknown,
  source: string,
): Promise<string | null> {
  const definition = RuleDefinition.parse(rule.definition)
  if (!(await RuleRuns.withinLimit(rule.id, definition.limits.maxRunsPerHour))) {
    await RuleRuns.recordSkip(rule.id, {
      triggerKind: 'webhook',
      reason: `Превышен лимит ${definition.limits.maxRunsPerHour} запусков в час`,
    })
    return null
  }
  return db().transaction((tx) =>
    RuleRuns.queue(tx, systemCtx('automation.webhook'), {
      ruleId: rule.id,
      triggerKind: 'webhook',
      runAs: definition.runAs,
      context: { trigger: 'rule.webhook', payload: { body, source } },
    }),
  )
}

/** Расписания правил для экрана «Расписания» (порт ядра). */
export const ruleScheduleProvider: EntityScheduleProvider = {
  kind: 'rule',
  list: async (): Promise<EntityScheduleEntry[]> => {
    const rows = await db()
      .select({ id: rules.id })
      .from(rules)
      .innerJoin(objects, eq(objects.id, rules.id))
      .where(isNull(objects.deletedAt))
    const out: EntityScheduleEntry[] = []
    for (const row of rows) {
      const rule = await RuleService.load(db(), row.id)
      if (!rule?.cron || !SCHEDULED_KINDS.includes(rule.triggerKind)) continue
      out.push({
        objectId: rule.id,
        title: rule.title,
        cron: rule.cron,
        timezone: rule.timezone ?? config().TZ,
        enabled: rule.enabled,
        queue: RULE_SCHEDULE_JOB.queue,
        job: RULE_SCHEDULE_JOB.name,
        lastRunAt: rule.lastRunAt,
        lastStatus: rule.lastStatus,
      })
    }
    return out
  },

  setEnabled: async (ctx, ruleId, enabled) => {
    await authorize(ctx, 'manage', ruleId)
    await db().transaction((tx) => RuleService.setEnabled(tx, ctx, ruleId, enabled))
    await syncRuleSchedule(ruleId)
  },

  runNow: async (ctx, ruleId) => {
    await authorize(ctx, 'manage', ruleId)
    const runId = await fireScheduledRule(ruleId)
    logger().info({ ruleId, runId }, 'расписание правила запущено вручную')
  },
}
