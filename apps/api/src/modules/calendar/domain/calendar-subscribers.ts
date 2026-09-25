import type { EventEnvelope, Locale, NotificationCategory, ReminderChannel } from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { recordModuleActivity } from '~/kernel/activity/service.js'
import type { Subscriber } from '~/kernel/events/types.js'
import { InboxService } from '~/kernel/inbox/service.js'
import { NotificationService } from '~/kernel/notifications/service.js'
import { emitToRoom, emitToUser } from '~/kernel/realtime/gateway.js'
import { UserService } from '~/modules/identity/public.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { eventAttendees, events } from '~/shared/db/schema/index.js'
import { CalendarService } from './calendar-service.js'
import { nextOccurrence } from './event-service.js'
import { formatWhen } from './format.js'
import { planReminders } from './reminders.js'
import { localDate } from './time.js'

/** Записи ленты по событиям календаря; создание пишет ядро (`object.created`). */
const ACTIVITY: Record<string, { verb: string; key: string }> = {
  'event.updated': { verb: 'updated', key: 'activity.event.updated' },
  'event.cancelled': { verb: 'cancelled', key: 'activity.event.cancelled' },
  'event.invited': { verb: 'invited', key: 'activity.event.invited' },
}

interface Participant {
  userId: string
  role: string
  status: string
}

async function participantsOf(eventId: string): Promise<Participant[]> {
  return db()
    .select({
      userId: eventAttendees.userId,
      role: eventAttendees.role,
      status: eventAttendees.status,
    })
    .from(eventAttendees)
    .where(eq(eventAttendees.eventId, eventId))
}

async function timingOf(eventId: string) {
  const [row] = await db().select().from(events).where(eq(events.id, eventId)).limit(1)
  return row ?? null
}

/**
 * Уведомление каждому получателю со временем встречи на его языке и в его
 * поясе. Приглашения, перенос и отмена — категория `meetings` (по умолчанию
 * и в Telegram), ответы — `calendar`.
 */
async function notifyEach(
  event: EventEnvelope,
  userIds: string[],
  input: {
    category: NotificationCategory
    titleKey: string
    when?: { startsAt: number; allDay: boolean; startDate: string | null } | null
    params?: Record<string, unknown>
    aggregateKey?: string
    channels?: ReminderChannel[]
    urgent?: boolean
  },
): Promise<void> {
  if (!event.object) return
  for (const userId of [...new Set(userIds)]) {
    if (userId === event.actor.userId && !input.urgent) continue
    const profile = await UserService.profile(userId)
    const locale = (profile?.locale as Locale | undefined) ?? 'ru'
    await NotificationService.notify({
      userIds: [userId],
      category: input.category,
      titleKey: input.titleKey,
      objectId: event.object.id,
      actorId: input.urgent ? null : event.actor.userId,
      url: `/o/${event.object.id}`,
      params: {
        title: event.object.title ?? '',
        ...(input.when
          ? {
              when: formatWhen(input.when, locale, {
                timezone: profile?.timezone ?? 'Asia/Dushanbe',
              }),
            }
          : {}),
        ...(input.params ?? {}),
      },
      ...(input.aggregateKey ? { aggregateKey: input.aggregateKey } : {}),
      ...(input.channels ? { channels: input.channels } : {}),
      ...(input.urgent ? { urgent: true } : {}),
    })
  }
}

async function notify(event: EventEnvelope): Promise<void> {
  if (!event.object) return
  const id = event.object.id
  const row = await timingOf(id)
  if (!row) return
  const next = await nextOccurrence(db(), row)
  switch (event.type) {
    case 'event.invited':
      await notifyEach(event, event.payload.userIds as string[], {
        category: 'meetings',
        titleKey: 'notifications.tpl.eventInvited',
        when: next,
      })
      break
    case 'event.uninvited':
      await notifyEach(event, event.payload.userIds as string[], {
        category: 'meetings',
        titleKey: 'notifications.tpl.eventUninvited',
      })
      break
    case 'event.updated': {
      const changed = (event.payload.changed as string[]) ?? []
      if (!event.payload.timeChanged && !changed.includes('location')) break
      const people = (await participantsOf(id)).filter((item) => item.status !== 'declined')
      await notifyEach(
        event,
        people.map((item) => item.userId),
        {
          category: 'meetings',
          titleKey: event.payload.timeChanged
            ? 'notifications.tpl.eventRescheduled'
            : 'notifications.tpl.eventChanged',
          when:
            event.payload.scope === 'occurrence' && typeof event.payload.startsAt === 'string'
              ? {
                  startsAt: Date.parse(event.payload.startsAt),
                  allDay: row.allDay,
                  startDate: null,
                }
              : next,
        },
      )
      break
    }
    case 'event.cancelled': {
      const people = (await participantsOf(id)).filter((item) => item.status !== 'declined')
      const occurrence =
        event.payload.scope === 'occurrence' && typeof event.payload.recurrenceId === 'string'
      await notifyEach(
        event,
        people.map((item) => item.userId),
        {
          category: 'meetings',
          titleKey: occurrence
            ? 'notifications.tpl.eventOccurrenceCancelled'
            : 'notifications.tpl.eventCancelled',
          when: occurrence
            ? {
                startsAt: Date.parse(event.payload.recurrenceId as string),
                allDay: row.allDay,
                startDate: row.allDay
                  ? localDate(Date.parse(event.payload.recurrenceId as string), row.timezone)
                  : null,
              }
            : null,
        },
      )
      break
    }
    case 'event.responded': {
      if (!row.organizerId) break
      const keys: Record<string, string> = {
        accepted: 'notifications.tpl.eventAccepted',
        tentative: 'notifications.tpl.eventTentative',
        declined: 'notifications.tpl.eventDeclined',
      }
      await notifyEach(event, [row.organizerId], {
        category: 'calendar',
        titleKey: event.payload.proposed
          ? 'notifications.tpl.eventProposed'
          : (keys[event.payload.status as string] ?? 'notifications.tpl.eventAccepted'),
      })
      break
    }
    default:
      break
  }
}

/** Напоминание — срочное уведомление в выбранные каналы; повтор доставки сливается. */
async function remind(event: EventEnvelope): Promise<void> {
  if (!event.object) return
  const userId = event.payload.userId as string
  const minutes = Number(event.payload.minutes ?? 0)
  const startsAt = Date.parse(String(event.payload.occurrenceStart))
  const row = await timingOf(event.object.id)
  await notifyEach(event, [userId], {
    category: 'calendar',
    titleKey: minutes === 0 ? 'notifications.tpl.eventStarting' : 'notifications.tpl.eventReminder',
    when: {
      startsAt,
      allDay: row?.allDay ?? false,
      startDate: row?.allDay ? localDate(startsAt, row.timezone) : null,
    },
    // Push доставляется, если у получателя есть подписанное устройство (ADR-0162)
    channels: (event.payload.channels as ReminderChannel[] | undefined) ?? ['app'],
    aggregateKey: `calendar:reminder:${event.object.id}:${String(event.payload.occurrenceStart)}:${minutes}`,
    urgent: true,
  })
}

async function activity(event: EventEnvelope): Promise<void> {
  if (!event.object) return
  if (event.type === 'event.responded') {
    // Ответ — своя запись на каждый вариант: в словаре нет выбора по значению
    const status = String(event.payload.status)
    await recordModuleActivity(event, { verb: status, key: `activity.event.${status}` })
    return
  }
  const mapping = ACTIVITY[event.type]
  if (mapping) await recordModuleActivity(event, mapping)
}

/**
 * Открытые вкладки события перечитывают его, календари участников — диапазон
 * (`calendar.changed` в комнату пользователя).
 */
async function refresh(event: EventEnvelope): Promise<void> {
  if (!event.object) return
  emitToRoom(`object:${event.object.id}`, 'object.updated', {
    id: event.object.id,
    type: event.object.type,
    version: 0,
    changedFields: ['calendar'],
    actorId: event.actor.userId,
  })
  if (event.object.type !== 'event') {
    if (event.actor.userId) emitToUser(event.actor.userId, 'calendar.changed', {})
    return
  }
  const people = await participantsOf(event.object.id)
  const recipients = new Set(people.map((item) => item.userId))
  for (const key of ['userIds'] as const) {
    const list = event.payload[key]
    if (Array.isArray(list)) for (const id of list) recipients.add(String(id))
  }
  if (event.actor.userId) recipients.add(event.actor.userId)
  for (const userId of recipients)
    emitToUser(userId, 'calendar.changed', { eventId: event.object.id })
}

/** Событие в корзине — его приглашения больше не ждут ответа; восстановленное — снова с напоминаниями. */
async function lifecycle(event: EventEnvelope): Promise<void> {
  if (event.object?.type !== 'event') return
  const ctx = systemCtx('calendar.lifecycle')
  if (event.type === 'object.trashed') {
    await InboxService.resolve(
      db(),
      ctx,
      { objectId: event.object.id, kind: 'respond_invite' },
      'dismissed',
    )
    return
  }
  if (event.type === 'object.restored') await planReminders(db(), [event.object.id])
}

/** Пространство подразделения получает свой календарь. */
async function spaceCalendar(event: EventEnvelope): Promise<void> {
  if (event.payload.kind !== 'unit' || !event.object) return
  const spaceId = event.object.id
  await db().transaction((tx) =>
    CalendarService.ensureSpaceCalendar(tx, systemCtx('calendar.space'), spaceId),
  )
}

export const calendarSubscribers: Subscriber[] = [
  {
    name: 'calendar-notifications',
    types: [
      'event.invited',
      'event.uninvited',
      'event.updated',
      'event.cancelled',
      'event.responded',
    ],
    handle: notify,
  },
  { name: 'calendar-reminders', types: ['event.reminder'], handle: remind },
  { name: 'calendar-activity', types: ['event.*'], handle: activity },
  { name: 'calendar-realtime', types: ['event.*', 'calendar.*'], handle: refresh },
  { name: 'calendar-lifecycle', types: ['object.trashed', 'object.restored'], handle: lifecycle },
  { name: 'calendar-spaces', types: ['space.created'], handle: spaceCalendar },
]
