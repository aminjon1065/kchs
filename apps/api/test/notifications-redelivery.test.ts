import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Повторная доставка события (ADR-0171): шина доставляет «как минимум один раз», и
 * после сбоя посреди обработки подписчик получает событие снова. Срочное уведомление
 * (ADR-0168 — не склеивается) не должно прийти дважды ни в приложении, ни в Telegram;
 * если же первая попытка не дошла до Telegram, повтор досылает его.
 */
registerLifecycle()

const { NotificationService } = await import('../src/kernel/notifications/service.js')
const { notificationChannel, setNotificationChannel } = await import(
  '../src/kernel/notifications/channels.js'
)
const { withEventDelivery } = await import('../src/kernel/events/delivery.js')

const run = Date.now().toString(36)
let fx: TestContext
const delivered: string[] = []
let failTelegram = false
const previousTelegram = notificationChannel('telegram')

beforeAll(async () => {
  fx = await setupFixture()
  setNotificationChannel('telegram', {
    available: async (userIds) => new Set(userIds),
    deliver: async (messages) => {
      if (failTelegram) {
        failTelegram = false
        throw new Error('Telegram недоступен')
      }
      for (const message of messages) delivered.push(message.text)
    },
  })
})

afterAll(() => {
  if (previousTelegram) setNotificationChannel('telegram', previousTelegram)
})

function alarm(text: string) {
  return {
    userIds: [fx.users.member.id],
    category: 'system' as const,
    titleKey: 'notifications.tpl.automation',
    params: { text },
    channels: ['app' as const, 'telegram' as const],
    urgent: true,
  }
}

async function rows(text: string): Promise<number> {
  const [row] = await db().execute<{ count: number }>(
    sql`SELECT count(*)::int AS count FROM notifications WHERE params->>'text' = ${text}`,
  )
  return row?.count ?? 0
}

const sent = (text: string) => delivered.filter((item) => item.includes(text)).length

describe('повторная доставка события', () => {
  it('срочное уведомление не дублируется ни в приложении, ни в Telegram', async () => {
    const text = `Землетрясение ${run}`
    const delivery = { subscriber: 'automation-rules', eventId: `evt-${run}` }
    await withEventDelivery(delivery, () => NotificationService.notify(alarm(text)))
    await withEventDelivery(delivery, () => NotificationService.notify(alarm(text)))
    expect(await rows(text)).toBe(1)
    expect(sent(text)).toBe(1)

    // Другое событие с тем же текстом — это новая тревога
    await withEventDelivery({ ...delivery, eventId: `evt-next-${run}` }, () =>
      NotificationService.notify(alarm(text)),
    )
    expect(await rows(text)).toBe(2)
    expect(sent(text)).toBe(2)
  })

  it('разные уведомления одного события — разные, даже одному получателю', async () => {
    const delivery = { subscriber: 'automation-rules', eventId: `evt-two-${run}` }
    await withEventDelivery(delivery, async () => {
      await NotificationService.notify(alarm(`Первое правило ${run}`))
      await NotificationService.notify(alarm(`Второе правило ${run}`))
    })
    expect(await rows(`Первое правило ${run}`)).toBe(1)
    expect(await rows(`Второе правило ${run}`)).toBe(1)
  })

  it('если первая попытка не дошла до Telegram, повтор досылает только его', async () => {
    const text = `Паводок ${run}`
    const delivery = { subscriber: 'alerts-deliver', eventId: `evt-flood-${run}` }
    failTelegram = true
    await withEventDelivery(delivery, () => NotificationService.notify(alarm(text)))
    expect(await rows(text)).toBe(1)
    expect(sent(text)).toBe(0)

    await withEventDelivery(delivery, () => NotificationService.notify(alarm(text)))
    expect(await rows(text)).toBe(1)
    expect(sent(text)).toBe(1)

    await withEventDelivery(delivery, () => NotificationService.notify(alarm(text)))
    expect(sent(text)).toBe(1)
  })

  it('вне обработки события поведение прежнее: каждое срочное — отдельной строкой', async () => {
    const text = `Без события ${run}`
    await NotificationService.notify(alarm(text))
    await NotificationService.notify(alarm(text))
    expect(await rows(text)).toBe(2)
  })
})
