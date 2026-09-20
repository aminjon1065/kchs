import { ALERT_CONDITION_KINDS } from '@kchs/contracts'
import { eq, sql } from 'drizzle-orm'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerInboxActionHandler } from '~/kernel/inbox/actions.js'
import { InboxService } from '~/kernel/inbox/service.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { declareSchedule } from '~/kernel/schedules/index.js'
import { db } from '~/shared/db/client.js'
import { alerts, objects } from '~/shared/db/schema/index.js'
import { AlertJobs } from './domain/alert-jobs.js'
import { alertSubscribers } from './domain/alert-subscribers.js'

export { registerAlertRoutes } from './http.js'

/**
 * Алерты на показатели (06-analytics-engine.md §14, ADR-0104). Алерт — объект
 * реестра: права как у всех объектов. Проверка — одно объявленное расписание
 * единого планировщика (ADR-0096).
 */
export function registerAlertObjectTypes(): void {
  registerObjectType({
    type: 'alert',
    labelKey: 'objects.types.alert',
    icon: 'alert-triangle',
    route: (id) => `/o/${id}`,
    levels: ['view', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      edit: { minLevel: 'manage' },
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage' },
    },
    discussable: false,
    linkable: true,
    hasParentTree: false,
    moduleManaged: true,
    listFields: [
      {
        key: 'enabled',
        labelKey: 'alerts.fields.enabled',
        type: 'boolean',
        sql: sql`(${objects.meta}->>'enabled')::boolean`,
        sortable: true,
      },
      {
        key: 'condition',
        labelKey: 'alerts.fields.condition',
        type: 'select',
        sql: sql`${objects.meta}->>'condition'`,
        options: ALERT_CONDITION_KINDS.map((value) => ({
          value,
          labelKey: `alerts.conditions.${value}`,
        })),
      },
    ],
    searchable: async (id) => {
      const [row] = await db()
        .select({
          title: objects.title,
          subtitle: objects.subtitle,
          spaceId: objects.spaceId,
          ownerId: objects.ownerId,
          parentId: objects.parentId,
          updatedAt: objects.updatedAt,
        })
        .from(alerts)
        .innerJoin(objects, eq(objects.id, alerts.id))
        .where(eq(alerts.id, id))
        .limit(1)
      if (!row) return null
      return {
        parentId: row.parentId,
        type: 'alert' as const,
        spaceId: row.spaceId,
        title: row.title,
        body: (row.subtitle ?? '').slice(0, 4000),
        ownerId: row.ownerId,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: {},
      }
    },
  })

  // «Разобрался» закрывает дело: само срабатывание остаётся в истории алерта
  registerInboxActionHandler('alert', async (ctx, { item }) => {
    await db().transaction((tx) =>
      InboxService.resolve(tx, ctx, {
        userId: item.userId,
        dedupeKey: item.payload.eventId ? `alert:${String(item.payload.eventId)}` : undefined,
      }),
    )
  })
}

/** Подписчики доставки и задания проверки — только в роли worker. */
export function registerAlertsBackground(): void {
  for (const subscriber of alertSubscribers) registerSubscriber(subscriber)

  registerJobHandler({
    queue: 'maintenance',
    name: 'alerts.check',
    concurrency: 1,
    handle: async () => ({ ...(await AlertJobs.tick()) }),
  })

  registerJobHandler({
    queue: 'maintenance',
    name: 'alerts.prune',
    concurrency: 1,
    handle: async () => ({ deleted: await AlertJobs.prune() }),
  })
}

/**
 * Расписание проверки — единый планировщик ядра (ADR-0096): один тик на все
 * алерты, срок каждого считается по его собственному выражению cron.
 */
export function scheduleAlertJobs(): void {
  declareSchedule({
    queue: 'maintenance',
    name: 'alerts.check',
    pattern: '*/5 * * * *',
    labelKey: 'schedules.jobs.alertsCheck',
  })
  declareSchedule({
    queue: 'maintenance',
    name: 'alerts.prune',
    pattern: '41 3 * * *',
    labelKey: 'schedules.jobs.alertsPrune',
  })
}
