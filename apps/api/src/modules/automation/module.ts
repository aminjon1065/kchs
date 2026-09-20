import { eq, sql } from 'drizzle-orm'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerFeature } from '~/kernel/features/registry.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { declareSchedule, setRuleScheduleProvider } from '~/kernel/schedules/index.js'
import { db } from '~/shared/db/client.js'
import { objects, rules } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { executeRun } from './domain/runner.js'
import { RuleRuns } from './domain/runs.js'
import {
  fireScheduledRule,
  RULE_SCHEDULE_JOB,
  ruleScheduleProvider,
  syncRuleSchedules,
} from './domain/schedules.js'
import { automationSubscribers } from './domain/subscribers.js'

export { registerAutomationRoutes } from './http.js'

/**
 * Правила автоматизации (14-automation-integrations.md §1, ADR-0096).
 * Правило — объект реестра: права как у всех объектов, ведение — способность
 * `automation.manage`, исполнение — от служебного пользователя правила.
 */
export function registerAutomationObjectTypes(): void {
  registerFeature({
    key: 'automation',
    titleKey: 'admin.features.items.automation.title',
    hintKey: 'admin.features.items.automation.hint',
    tags: ['automation'],
    objectTypes: ['rule'],
  })

  registerObjectType({
    type: 'rule',
    labelKey: 'objects.types.rule',
    icon: 'zap',
    route: (id) => `/o/${id}`,
    levels: ['view', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      edit: { minLevel: 'edit', capability: 'automation.manage' },
      manage: { minLevel: 'manage', capability: 'automation.manage' },
      /** Ручной запуск у объекта: достаточно видеть правило. */
      run: { minLevel: 'view' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage', capability: 'automation.manage' },
    },
    discussable: false,
    linkable: true,
    hasParentTree: false,
    moduleManaged: true,
    listFields: [
      {
        key: 'enabled',
        labelKey: 'automation.fields.enabled',
        type: 'boolean',
        sql: sql`(${objects.meta}->>'enabled')::boolean`,
        sortable: true,
      },
      {
        key: 'triggerKind',
        labelKey: 'automation.fields.trigger',
        type: 'select',
        sql: sql`${objects.meta}->>'triggerKind'`,
        options: [
          { value: 'event', labelKey: 'automation.triggers.event' },
          { value: 'schedule', labelKey: 'automation.triggers.schedule' },
          { value: 'webhook', labelKey: 'automation.triggers.webhook' },
          { value: 'manual', labelKey: 'automation.triggers.manual' },
          { value: 'metric', labelKey: 'automation.triggers.metric' },
        ],
      },
    ],
    searchable: async (id) => {
      const [row] = await db()
        .select({
          title: objects.title,
          spaceId: objects.spaceId,
          ownerId: objects.ownerId,
          updatedAt: objects.updatedAt,
          key: rules.key,
          definition: rules.definition,
        })
        .from(rules)
        .innerJoin(objects, eq(objects.id, rules.id))
        .where(eq(rules.id, id))
        .limit(1)
      if (!row) return null
      const description = (row.definition as { description?: string | null }).description ?? ''
      return {
        parentId: null,
        type: 'rule',
        spaceId: row.spaceId,
        title: row.title,
        body: [row.key, description].join('\n').slice(0, 4000),
        ownerId: row.ownerId,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: {},
      }
    },
  })
}

/** Подписчики и обработчики заданий — только в роли worker. */
export function registerAutomationBackground(): void {
  for (const subscriber of automationSubscribers()) registerSubscriber(subscriber)

  registerJobHandler({
    queue: 'automation',
    name: 'rule.run',
    concurrency: 4,
    handle: async (job) => {
      const outcome = await executeRun(String(job.data.runId))
      return { ...outcome }
    },
  })

  registerJobHandler({
    ...RULE_SCHEDULE_JOB,
    concurrency: 2,
    handle: async (job) => ({ runId: await fireScheduledRule(String(job.data.ruleId)) }),
  })

  registerJobHandler({
    queue: 'maintenance',
    name: 'automation.prune',
    concurrency: 1,
    handle: async () => ({ deleted: await RuleRuns.prune(30) }),
  })

  registerJobHandler({
    queue: 'maintenance',
    name: 'automation.resume',
    concurrency: 1,
    handle: async () => {
      const stale = await RuleRuns.stale(10)
      for (const runId of stale) await executeRun(runId)
      return { resumed: stale.length }
    },
  })
}

/** Расписания правил и обслуживание журнала — при старте воркера. */
export async function scheduleAutomationJobs(): Promise<void> {
  declareSchedule({
    queue: 'maintenance',
    name: 'automation.prune',
    pattern: '47 3 * * *',
    labelKey: 'schedules.jobs.automationPrune',
  })
  declareSchedule({
    queue: 'maintenance',
    name: 'automation.resume',
    pattern: '*/5 * * * *',
    labelKey: 'schedules.jobs.automationResume',
  })
  setRuleScheduleProvider(ruleScheduleProvider)
  const count = await syncRuleSchedules()
  logger().info({ rules: count }, 'расписания правил автоматизации синхронизированы')
}
