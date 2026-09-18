import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  FAKE_BOT_USERNAME,
  type FakeTelegram,
  startFakeTelegram,
  telegramMessage,
} from './fakes.js'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Telegram-бот (P1-E09 S01, ADR-0061): привязка одноразовой ссылкой, канал
 * уведомлений ядра, отвязка. Bot API — поддельный сервер, настоящий Telegram
 * не вызывается.
 */
registerLifecycle()

const { resetConfigCache } = await import('../src/shared/config/env.js')
const { handleTelegramUpdate } = await import('../src/modules/telegram/domain/bot.js')
const { startTelegramPolling, stopTelegramPolling } = await import(
  '../src/modules/telegram/domain/poller.js'
)
const { NotificationService } = await import('../src/kernel/notifications/service.js')

let fx: TestContext
let telegram: FakeTelegram
let folderId: string
let nextUpdate = 1

const MEMBER_CHAT = 5550001

function configure(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetConfigCache()
}

async function linkUrl(as = fx.users.member): Promise<string> {
  const response = await call(fx.app, { method: 'POST', url: '/me/telegram/link', as })
  expect(response.statusCode).toBe(200)
  return response.json().url
}

const tokenOf = (url: string) => new URL(url).searchParams.get('start') ?? ''

async function say(chatId: number, text: string, options: { type?: 'private' | 'group' } = {}) {
  const before = telegram.sent().length
  await handleTelegramUpdate(
    telegramMessage(nextUpdate++, { id: chatId, ...options }, text, {
      username: 'member_tg',
    }) as never,
  )
  return telegram.sent().slice(before)
}

/** События задачи — подписчику уведомлений модуля задач, как воркер. */
async function deliverTaskEvents(taskId: string): Promise<void> {
  const { listSubscribers, matchesType } = await import('../src/kernel/events/bus.js')
  if (!listSubscribers().some((subscriber) => subscriber.name === 'tasks-notifications')) {
    const { registerTasksBackground } = await import('../src/modules/tasks/module.js')
    registerTasksBackground()
  }
  const rows = await db().execute<{ event: { type: string } }>(
    sql`SELECT event FROM ops.outbox WHERE event->'object'->>'id' = ${taskId} ORDER BY id`,
  )
  for (const { event } of rows) {
    for (const subscriber of listSubscribers()) {
      if (subscriber.name !== 'tasks-notifications') continue
      if (matchesType(subscriber.types, event.type)) await subscriber.handle(event as never)
    }
  }
}

async function outboxTypes(userId: string): Promise<string[]> {
  const rows = await db().execute<{ type: string }>(
    sql`SELECT type FROM ops.outbox WHERE event->'payload'->>'userId' = ${userId} ORDER BY id`,
  )
  return rows.map((row) => row.type)
}

beforeAll(async () => {
  fx = await setupFixture()
  telegram = await startFakeTelegram()
  const folder = await call(fx.app, {
    method: 'POST',
    url: '/folders',
    as: fx.admin,
    payload: { name: 'Материалы для исполнителя', spaceId: fx.spaceId },
  })
  folderId = folder.json().id
})

afterAll(async () => {
  await stopTelegramPolling()
  configure({ TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_API_URL: undefined })
  await telegram?.close()
})

describe('Telegram без токена бота', () => {
  it('функция скрыта: статус выключен, ссылка не выдаётся', async () => {
    configure({ TELEGRAM_BOT_TOKEN: undefined })
    const status = await call(fx.app, { url: '/me/telegram', as: fx.users.member })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({ enabled: false, linked: false, botUsername: null })

    const link = await call(fx.app, {
      method: 'POST',
      url: '/me/telegram/link',
      as: fx.users.member,
    })
    expect(link.statusCode).toBe(503)
  })
})

describe('Telegram: привязка и уведомления', () => {
  beforeAll(() => {
    configure({ TELEGRAM_BOT_TOKEN: telegram.token, TELEGRAM_API_URL: telegram.url })
  })

  it('одноразовая ссылка привязывает личный чат к пользователю', async () => {
    const status = await call(fx.app, { url: '/me/telegram', as: fx.users.member })
    expect(status.json()).toMatchObject({
      enabled: true,
      linked: false,
      botUsername: FAKE_BOT_USERNAME,
    })

    const url = await linkUrl()
    expect(url).toMatch(
      new RegExp(`^https://t\\.me/${FAKE_BOT_USERNAME}\\?start=[A-Za-z0-9_-]{16,64}$`),
    )

    const replies = await say(MEMBER_CHAT, `/start ${tokenOf(url)}`)
    expect(replies).toHaveLength(1)
    expect(replies[0]?.chatId).toBe(MEMBER_CHAT)
    expect(replies[0]?.text).toContain('подключён к аккаунту')

    const linked = await call(fx.app, { url: '/me/telegram', as: fx.users.member })
    expect(linked.json()).toMatchObject({ enabled: true, linked: true, username: 'member_tg' })
    expect(linked.json().linkedAt).toBeTruthy()
    expect(await outboxTypes(fx.users.member.id)).toContain('user.telegram_linked')

    // Токен одноразовый: повтор той же ссылки не привязывает
    const again = await say(MEMBER_CHAT, `/start ${tokenOf(url)}`)
    expect(again[0]?.text).toContain('устарела')
  })

  it('чужой токен и групповой чат не привязываются', async () => {
    const forged = await say(MEMBER_CHAT + 1, '/start abcdefghijklmnopqrstuvwxyz012345')
    expect(forged[0]?.text).toContain('устарела')

    // В группе бот молчит: уведомления личные
    const url = await linkUrl(fx.users.viewer)
    const group = await say(-100500, `/start ${tokenOf(url)}`, { type: 'group' })
    expect(group).toHaveLength(0)
    const viewer = await call(fx.app, { url: '/me/telegram', as: fx.users.viewer })
    expect(viewer.json().linked).toBe(false)

    // Чат уже принадлежит другому пользователю
    const taken = await say(MEMBER_CHAT, `/start ${tokenOf(url)}`)
    expect(taken[0]?.text).toContain('другому аккаунту')
  })

  it('упоминание приходит в Telegram на языке пользователя со ссылкой на вкладку объекта', async () => {
    const before = telegram.sent().length
    await NotificationService.notify({
      userIds: [fx.users.member.id],
      category: 'mention',
      titleKey: 'notifications.tpl.mention',
      params: { title: 'Материалы для исполнителя' },
      objectId: folderId,
      actorId: fx.admin.id,
      url: `/o/${folderId}`,
    })
    const sent = telegram.sent().slice(before)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.chatId).toBe(MEMBER_CHAT)
    expect(sent[0]?.text).toContain('упомянул вас')
    expect(sent[0]?.text).toContain('Материалы для исполнителя')
    const base = (process.env.KCHS_BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '')
    expect(sent[0]?.text).toContain(`${base}/o/${folderId}`)

    const [row] = await db().execute<{ channels: string[] }>(
      sql`SELECT channels FROM notifications
           WHERE user_id = ${fx.users.member.id} AND category = 'mention'
           ORDER BY id DESC LIMIT 1`,
    )
    expect(row?.channels).toContain('telegram')
  })

  it('поручение: исполнитель получает назначение в Telegram со ссылкой на задачу (сценарий №6)', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/tasks',
      as: fx.admin,
      payload: {
        kind: 'instruction',
        title: `Уточнить сводку по паводку ${Date.now().toString(36)}`,
        spaceId: fx.spaceId,
        assigneeId: fx.users.member.id,
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const taskId = created.json().id as string

    const before = telegram.sent().length
    await deliverTaskEvents(taskId)
    const sent = telegram.sent().slice(before)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.chatId).toBe(MEMBER_CHAT)
    expect(sent[0]?.text).toContain('Уточнить сводку по паводку')
    const base = (process.env.KCHS_BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '')
    expect(sent[0]?.text).toContain(`${base}/o/${taskId}`)
  })

  it('категории вне правил по умолчанию — только после включения в настройках', async () => {
    const notify = () =>
      NotificationService.notify({
        userIds: [fx.users.member.id],
        category: 'object',
        titleKey: 'notifications.tpl.objectShared',
        params: { title: 'Материалы для исполнителя' },
        objectId: folderId,
        actorId: fx.admin.id,
        url: `/o/${folderId}`,
        aggregateKey: `object-share-${Date.now()}`,
      })

    const before = telegram.sent().length
    await notify()
    expect(telegram.sent().length).toBe(before)

    const prefs = await call(fx.app, { url: '/me/notification-preferences', as: fx.users.member })
    expect(prefs.json().defaults).toContainEqual({
      category: 'object',
      channel: 'telegram',
      mode: 'off',
    })
    expect(prefs.json().defaults).toContainEqual({
      category: 'inbox',
      channel: 'telegram',
      mode: 'immediate',
    })
    // Поручения — действия: назначение приходит в Telegram без настройки (сценарий №6)
    expect(prefs.json().defaults).toContainEqual({
      category: 'tasks',
      channel: 'telegram',
      mode: 'immediate',
    })

    const set = await call(fx.app, {
      method: 'PUT',
      url: '/me/notification-preferences',
      as: fx.users.member,
      payload: { category: 'object', channel: 'telegram', mode: 'immediate' },
    })
    expect(set.statusCode).toBe(200)
    await notify()
    expect(telegram.sent().length).toBe(before + 1)
  })

  it('без привязки Telegram не попадает в каналы уведомления', async () => {
    const before = telegram.sent().length
    await NotificationService.notify({
      userIds: [fx.users.stranger.id],
      category: 'mention',
      titleKey: 'notifications.tpl.mention',
      params: { title: 'Черновик' },
      actorId: fx.admin.id,
      url: '/',
    })
    expect(telegram.sent().length).toBe(before)
    const [row] = await db().execute<{ channels: string[] }>(
      sql`SELECT channels FROM notifications WHERE user_id = ${fx.users.stranger.id}
           ORDER BY id DESC LIMIT 1`,
    )
    expect(row?.channels).not.toContain('telegram')
  })

  it('/stop отвязывает чат, заблокированный бот снимает привязку сам', async () => {
    const replies = await say(MEMBER_CHAT, '/stop')
    expect(replies[0]?.text).toContain('отключены')
    expect((await call(fx.app, { url: '/me/telegram', as: fx.users.member })).json().linked).toBe(
      false,
    )

    // Снова привязываем и «блокируем» бота в Telegram
    await say(MEMBER_CHAT, `/start ${tokenOf(await linkUrl())}`)
    telegram.block(MEMBER_CHAT)
    await NotificationService.notify({
      userIds: [fx.users.member.id],
      category: 'inbox',
      titleKey: 'notifications.tpl.inboxAssigned',
      params: { title: 'Проверить данные' },
      objectId: folderId,
      url: `/o/${folderId}`,
    })
    expect((await call(fx.app, { url: '/me/telegram', as: fx.users.member })).json().linked).toBe(
      false,
    )
    const [event] = await db().execute<{ reason: string }>(
      sql`SELECT event->'payload'->>'reason' AS reason FROM ops.outbox
           WHERE type = 'user.telegram_unlinked' ORDER BY id DESC LIMIT 1`,
    )
    expect(event?.reason).toBe('blocked')
  })

  it('отвязка из профиля', async () => {
    const chat = MEMBER_CHAT + 10
    await say(chat, `/start ${tokenOf(await linkUrl(fx.users.viewer))}`)
    expect((await call(fx.app, { url: '/me/telegram', as: fx.users.viewer })).json().linked).toBe(
      true,
    )
    const before = telegram.sent().length
    const removed = await call(fx.app, {
      method: 'DELETE',
      url: '/me/telegram',
      as: fx.users.viewer,
    })
    expect(removed.json()).toEqual({ ok: true })
    // Бот сообщает в чат, что уведомления отключены
    expect(telegram.sent().slice(before)[0]?.chatId).toBe(chat)
    const again = await call(fx.app, { method: 'DELETE', url: '/me/telegram', as: fx.users.viewer })
    expect(again.json()).toEqual({ ok: false })
  })

  it('долгий опрос в роли worker принимает /start из очереди Bot API', async () => {
    const url = await linkUrl(fx.users.stranger)
    telegram.push(
      telegramMessage(900, { id: MEMBER_CHAT + 20 }, `/start ${tokenOf(url)}`, {
        username: 'stranger_tg',
      }),
    )
    startTelegramPolling()
    await vi.waitFor(
      async () => {
        const status = await call(fx.app, { url: '/me/telegram', as: fx.users.stranger })
        expect(status.json().linked).toBe(true)
      },
      { timeout: 10_000, interval: 200 },
    )
    await stopTelegramPolling()
    expect(telegram.calls.some((recorded) => recorded.method === 'getUpdates')).toBe(true)
  })
})
