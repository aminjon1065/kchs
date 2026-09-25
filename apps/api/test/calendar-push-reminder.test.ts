import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ChannelMessage,
  setNotificationChannel,
} from '../src/kernel/notifications/channels.js'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Напоминание о событии в канал push (ADR-0162): канал выбирается в
 * напоминании, доставляется тем, у кого есть подписанное устройство. Канал
 * подменён записывающим адаптером — модуль push и ключи VAPID не нужны.
 */
registerLifecycle()

const { dispatchDueReminders, planReminders } = await import(
  '../src/modules/calendar/domain/reminders.js'
)

const run = Date.now().toString(36)
let fx: TestContext
const pushed: ChannelMessage[] = []

/** Подписчики ядра и календаря по неопубликованным событиям outbox — как воркер. */
async function drainOutbox(): Promise<void> {
  const { listSubscribers, matchesType } = await import('../src/kernel/events/bus.js')
  if (!listSubscribers().some((subscriber) => subscriber.name === 'kernel-notifications')) {
    const { registerKernelSubscribers } = await import('../src/kernel/subscribers.js')
    registerKernelSubscribers()
  }
  if (!listSubscribers().some((subscriber) => subscriber.name === 'calendar-notifications')) {
    const { registerCalendarBackground } = await import('../src/modules/calendar/module.js')
    registerCalendarBackground()
  }
  const rows = await db().execute<{ id: number; event: unknown }>(
    sql`SELECT id, event FROM ops.outbox WHERE published_at IS NULL ORDER BY id LIMIT 2000`,
  )
  for (const row of rows) {
    const event = row.event as { type: string }
    for (const subscriber of listSubscribers()) {
      if (!matchesType(subscriber.types, event.type)) continue
      await subscriber.handle(event as never)
    }
    await db().execute(sql`UPDATE ops.outbox SET published_at = now() WHERE id = ${row.id}`)
  }
}

beforeAll(async () => {
  fx = await setupFixture()
  // Устройство подписано только у одного участника
  setNotificationChannel('push', {
    available: async (userIds) => new Set(userIds.filter((id) => id === fx.users.stranger.id)),
    deliver: async (messages) => {
      pushed.push(...messages)
    },
  })
})

afterAll(() => setNotificationChannel('push', null))

describe('напоминание в push', () => {
  it('уходит на устройство тому, у кого оно подписано', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/events',
      as: fx.users.member,
      payload: {
        title: `Штаб ${run}`,
        startsAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        endsAt: new Date(Date.now() + 35 * 60_000).toISOString(),
        attendees: [{ userId: fx.users.stranger.id }],
        reminders: [{ minutes: 10, channels: ['app', 'push'] }],
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const eventId = created.json().id as string

    await planReminders(db(), [eventId])
    expect(await dispatchDueReminders()).toBe(2)
    await drainOutbox()

    // Приглашение тоже может прийти в push по настройкам категории — считаем напоминания
    const reminder = (message: ChannelMessage) => message.text.includes('Напоминание')
    const mine = pushed.filter(
      (message) => message.userId === fx.users.stranger.id && reminder(message),
    )
    expect(mine).toHaveLength(1)
    expect(mine[0]?.text).toContain(`Штаб ${run}`)
    expect(mine[0]?.url).toContain(`/o/${eventId}`)
    // У организатора устройства нет — push ему не уходит, остаётся «В приложении»
    expect(pushed.some((message) => message.userId === fx.users.member.id)).toBe(false)
    expect(pushed.filter(reminder)).toHaveLength(1)
    const [row] = await db().execute<{ channels: string[] }>(
      sql`SELECT channels FROM notifications
           WHERE user_id = ${fx.users.stranger.id} AND object_id = ${eventId}
           ORDER BY id DESC LIMIT 1`,
    )
    expect(row?.channels).toEqual(expect.arrayContaining(['app', 'push']))
  })
})
