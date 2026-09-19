import { atLeast, ResponseStatus } from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerInboxActionHandler } from '~/kernel/inbox/actions.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { JobService, queue } from '~/kernel/jobs/service.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { SpaceService } from '~/kernel/spaces/service.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { calendars, events, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { CALENDAR_SYNC_JOB, CalendarService } from './domain/calendar-service.js'
import { calendarSubscribers } from './domain/calendar-subscribers.js'
import { EventService } from './domain/event-service.js'
import { IcsService, subscriptionsDue } from './domain/ics-service.js'
import { extendHorizons } from './domain/instances.js'
import { dispatchDueReminders, planReminders, pruneReminders } from './domain/reminders.js'

export { registerCalendarRoutes } from './http.js'

/**
 * Типы `calendar` и `event` (ADR-0081) и ответы на приглашения из Входящих —
 * при старте в любой роли: HTTP исполняет кнопки Входящих, воркер — подписчиков.
 */
export function registerCalendarObjectTypes(): void {
  registerObjectType({
    type: 'calendar',
    labelKey: 'objects.types.calendar',
    icon: 'calendar',
    route: (id) => `/o/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      comment: { minLevel: 'comment' },
      edit: { minLevel: 'edit' },
      /** Создавать события календаря. */
      create_event: { minLevel: 'edit' },
      /** Загрузить `.ics`. */
      import: { minLevel: 'edit' },
      /** Бронировать ресурс — всем, кто видит ресурсный календарь. */
      book: { minLevel: 'view' },
      /** Выпустить ссылку ICS-подписки — с правами выпустившего. */
      feed: { minLevel: 'view' },
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage' },
    },
    discussable: false,
    linkable: true,
    hasParentTree: true,
    searchable: async (id) => {
      const [row] = await db()
        .select({
          title: objects.title,
          spaceId: objects.spaceId,
          parentId: objects.parentId,
          ownerId: objects.ownerId,
          updatedAt: objects.updatedAt,
          kind: calendars.kind,
          description: calendars.description,
        })
        .from(calendars)
        .innerJoin(objects, eq(objects.id, calendars.id))
        .where(eq(calendars.id, id))
        .limit(1)
      if (!row) return null
      return {
        parentId: row.parentId,
        type: 'calendar',
        spaceId: row.spaceId,
        title: row.title,
        body: row.description ?? '',
        ownerId: row.ownerId,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: { kind: row.kind },
      }
    },
  })

  registerObjectType({
    type: 'event',
    labelKey: 'objects.types.event',
    icon: 'event',
    route: (id) => `/o/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      comment: { minLevel: 'comment' },
      edit: { minLevel: 'edit' },
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: false,
    policy: {
      // «Занято»: детали видят участники (записи ACL) и те, кто правит календарь
      derive: async (ctx, object) => {
        if (object.meta.visibility !== 'busy' || !object.parentId) return []
        const decision = await authorize(ctx, 'view', object.parentId, { soft: true })
        if (!decision.allowed || !atLeast(decision.level, 'edit')) return []
        return [
          {
            level: 'edit' as const,
            reason: {
              kind: 'type_policy' as const,
              level: 'edit' as const,
              messageKey: 'access.reason.type_policy',
              params: { policy: 'Редактор календаря' },
              sourceObjectId: object.parentId,
            },
          },
        ]
      },
    },
    searchable: async (id) => {
      const [row] = await db()
        .select({
          title: objects.title,
          spaceId: objects.spaceId,
          parentId: objects.parentId,
          ownerId: objects.ownerId,
          updatedAt: objects.updatedAt,
          description: events.description,
          location: events.location,
          startsAt: events.startsAt,
        })
        .from(events)
        .innerJoin(objects, eq(objects.id, events.id))
        .where(eq(events.id, id))
        .limit(1)
      if (!row) return null
      return {
        parentId: row.parentId,
        type: 'event',
        spaceId: row.spaceId,
        title: row.title,
        body: [row.location ?? '', row.description ?? ''].join('\n').slice(0, 20_000),
        ownerId: row.ownerId,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: { startsAt: row.startsAt },
      }
    },
  })

  // Ответ на приглашение из Входящих и из Telegram — тем же действием, что в карточке
  registerInboxActionHandler('respond_invite', async (ctx, { item, action, comment }) => {
    const status = ResponseStatus.safeParse(action)
    if (!status.success || !item.objectId) throw errors.validation('Нет такого действия')
    const eventId = item.objectId
    await db().transaction((tx) =>
      EventService.respond(tx, ctx, eventId, {
        status: status.data,
        ...(comment ? { comment } : {}),
      }),
    )
  })
}

/** Подписчики и задания модуля — только в роли worker. */
export function registerCalendarBackground(): void {
  for (const subscriber of calendarSubscribers) registerSubscriber(subscriber)

  registerJobHandler({
    queue: 'notify',
    name: 'calendar.reminders',
    concurrency: 1,
    handle: async () => ({ sent: await dispatchDueReminders() }),
  })
  registerJobHandler({
    queue: 'maintenance',
    name: 'calendar.plan',
    concurrency: 1,
    handle: async () => ({
      planned: await planReminders(db(), null),
      pruned: await pruneReminders(),
    }),
  })
  registerJobHandler({
    queue: 'maintenance',
    name: 'calendar.horizon',
    concurrency: 1,
    handle: async () => ({ extended: await extendHorizons() }),
  })
  registerJobHandler({
    queue: 'automation',
    name: 'calendar.subscriptions',
    concurrency: 1,
    handle: async () => {
      const ids = await subscriptionsDue()
      const slot = Math.floor(Date.now() / (30 * 60_000))
      for (const calendarId of ids) {
        await JobService.enqueue(systemCtx('calendar.subscriptions'), {
          ...CALENDAR_SYNC_JOB,
          data: { calendarId },
          objectId: calendarId,
          idempotencyKey: `calendar.sync:${calendarId}:${slot}`,
        })
      }
      return { scheduled: ids.length }
    },
  })
  registerJobHandler({
    ...CALENDAR_SYNC_JOB,
    concurrency: 2,
    handle: async (job) => {
      await IcsService.syncSubscription(String(job.data.calendarId))
      return {}
    },
  })
}

/**
 * Расписания модуля и календари пространств подразделений, созданных до
 * появления модуля (при старте воркера, идемпотентно).
 */
export async function scheduleCalendarJobs(): Promise<void> {
  await queue('notify').add(
    'calendar.reminders',
    {},
    { repeat: { pattern: '* * * * *' }, jobId: 'cron:calendar.reminders' },
  )
  await queue('maintenance').add(
    'calendar.plan',
    {},
    { repeat: { pattern: '7 * * * *' }, jobId: 'cron:calendar.plan' },
  )
  await queue('maintenance').add(
    'calendar.horizon',
    {},
    { repeat: { pattern: '37 2 * * *' }, jobId: 'cron:calendar.horizon' },
  )
  await queue('automation').add(
    'calendar.subscriptions',
    {},
    { repeat: { pattern: '*/30 * * * *' }, jobId: 'cron:calendar.subscriptions' },
  )
  await ensureUnitCalendars()
}

/** Календари для пространств подразделений, у которых их ещё нет. */
export async function ensureUnitCalendars(): Promise<number> {
  const ctx = systemCtx('calendar.units')
  let created = 0
  for (const space of await SpaceService.adminList({ kind: 'unit' })) {
    try {
      const existed = await db()
        .select({ id: calendars.id })
        .from(calendars)
        .where(eq(calendars.systemKey, `space:${space.id}`))
        .limit(1)
      if (existed.length > 0) continue
      await db().transaction((tx) => CalendarService.ensureSpaceCalendar(tx, ctx, space.id))
      created += 1
    } catch (error) {
      logger().warn({ err: error, spaceId: space.id }, 'календарь подразделения не создан')
    }
  }
  return created
}
