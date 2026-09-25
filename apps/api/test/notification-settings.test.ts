import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Настройки уведомлений и центр уведомлений (ADR-0153): push по умолчанию — как Telegram
 * (подписанное устройство получает действия, а не молчит), выключенный канал молчит,
 * категория проверяется контрактом, одно уведомление отмечается прочитанным отдельно.
 */
registerLifecycle()

const { NotificationService } = await import('../src/kernel/notifications/service.js')
const { notificationChannel, setNotificationChannel } = await import(
  '../src/kernel/notifications/channels.js'
)

const run = Date.now().toString(36)
let fx: TestContext
const pushed: Array<{ userId: string; text: string }> = []
const previousPush = notificationChannel('push')

beforeAll(async () => {
  fx = await setupFixture()
  // Устройство «подписано» у всех: доставка копится в памяти теста
  setNotificationChannel('push', {
    available: async (userIds) => new Set(userIds),
    deliver: async (messages) => {
      for (const message of messages) pushed.push({ userId: message.userId, text: message.text })
    },
  })
})

afterAll(() => {
  if (previousPush) setNotificationChannel('push', previousPush)
})

const pushedTo = (text: string) =>
  pushed.some((item) => item.userId === fx.users.member.id && item.text.includes(text))

async function notifyMember(category: 'tasks' | 'object', text: string) {
  await NotificationService.notify({
    userIds: [fx.users.member.id],
    category,
    titleKey: 'notifications.tpl.inboxAssigned',
    params: { title: text },
    aggregateKey: `${category}:${text}`,
  })
}

describe('настройки уведомлений', () => {
  it('push по умолчанию — как Telegram; выключенный — молчит; категория проверяется', async () => {
    const prefs = await call(fx.app, { url: '/me/notification-preferences', as: fx.users.member })
    expect(prefs.statusCode, prefs.body).toBe(200)
    const defaults = prefs.json().defaults as Array<{
      category: string
      channel: string
      mode: string
    }>
    expect(defaults).toContainEqual({ category: 'tasks', channel: 'push', mode: 'immediate' })
    expect(defaults).toContainEqual({ category: 'object', channel: 'push', mode: 'off' })

    await notifyMember('tasks', `Поручение по умолчанию ${run}`)
    expect(pushedTo(`Поручение по умолчанию ${run}`)).toBe(true)

    const off = await call(fx.app, {
      method: 'PUT',
      url: '/me/notification-preferences',
      as: fx.users.member,
      payload: { category: 'tasks', channel: 'push', mode: 'off' },
    })
    expect(off.statusCode, off.body).toBe(200)
    await notifyMember('tasks', `Поручение без push ${run}`)
    expect(pushedTo(`Поручение без push ${run}`)).toBe(false)

    const wrong = await call(fx.app, {
      method: 'PUT',
      url: '/me/notification-preferences',
      as: fx.users.member,
      payload: { category: 'нет такой', channel: 'push', mode: 'off' },
    })
    expect(wrong.statusCode).toBe(400)
  })

  it('одно уведомление отмечается прочитанным, остальные — нет', async () => {
    await notifyMember('object', `Первое ${run}`)
    await notifyMember('object', `Второе ${run}`)
    const list = await call(fx.app, {
      url: '/notifications?unreadOnly=true&limit=100',
      as: fx.users.member,
    })
    const items = list.json().items as Array<{ id: string; title: string }>
    const first = items.find((item) => item.title.includes(`Первое ${run}`))
    const second = items.find((item) => item.title.includes(`Второе ${run}`))
    expect(first && second).toBeTruthy()
    const before = list.json().unread as number

    const read = await call(fx.app, {
      method: 'POST',
      url: '/notifications/read',
      as: fx.users.member,
      payload: { ids: [first?.id] },
    })
    expect(read.statusCode, read.body).toBe(200)
    expect(read.json().unread).toBe(before - 1)
    const after = (
      await call(fx.app, { url: '/notifications?unreadOnly=true&limit=100', as: fx.users.member })
    ).json().items as Array<{ id: string }>
    expect(after.map((item) => item.id)).not.toContain(first?.id)
    expect(after.map((item) => item.id)).toContain(second?.id)
  })
})
