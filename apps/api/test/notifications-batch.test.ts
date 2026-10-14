import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Уведомление многим получателям (ADR-0222): настройки, повторы, агрегация и вставка —
 * запрос на пачку, а не на получателя; письма уходят одним вызовом доставки, внешний
 * канал получает одну пачку сообщений после записи строк. Настройки каждого получателя,
 * агрегация и автор действия работают как при поштучной обработке.
 */
registerLifecycle()

const { NotificationService } = await import('../src/kernel/notifications/service.js')
const { notificationChannel, setNotificationChannel } = await import(
  '../src/kernel/notifications/channels.js'
)
const { UserService } = await import('../src/kernel/directory/service.js')
const { systemCtx } = await import('../src/shared/context.js')
const { notificationPreferences } = await import('../src/db-schema.js')

const run = Date.now().toString(36)
const COUNT = 30
let fx: TestContext
const recipients: string[] = []
const batches: Array<Array<{ userId: string; text: string }>> = []
let rowsAtDelivery = -1
const previousTelegram = notificationChannel('telegram')

async function rowsOf(text: string) {
  return db().execute<{
    user_id: string
    aggregate_count: number
    external_sent_at: string | null
  }>(
    sql`SELECT user_id, aggregate_count, external_sent_at FROM notifications WHERE params->>'text' = ${text}`,
  )
}

beforeAll(async () => {
  fx = await setupFixture()
  const ctx = systemCtx('test')
  await db().transaction(async (tx) => {
    for (let i = 0; i < COUNT; i += 1) {
      const { id } = await UserService.create(tx, ctx, {
        login: `batch_${run}_${i}`,
        email: `batch_${run}_${i}@test.local`,
        lastName: 'Пачкин',
        firstName: `Получатель ${i}`,
        roleKeys: ['employee'],
        mustChangePassword: false,
        locale: 'ru',
        timezone: 'Asia/Dushanbe',
        unitId: null,
      })
      recipients.push(id)
    }
  })
  // Второй получатель выключил Telegram для системных уведомлений
  await db()
    .insert(notificationPreferences)
    .values({ userId: recipients[1] ?? '', category: 'system', channel: 'telegram', mode: 'off' })
  setNotificationChannel('telegram', {
    available: async (userIds) => new Set(userIds),
    deliver: async (messages) => {
      rowsAtDelivery = (await rowsOf(`Пачка ${run}`)).length
      batches.push(messages.map((message) => ({ userId: message.userId, text: message.text })))
    },
  })
})

afterAll(() => {
  if (previousTelegram) setNotificationChannel('telegram', previousTelegram)
})

function notice(text: string) {
  return {
    // Автор действия среди адресатов — ему уведомления нет
    userIds: [...recipients, fx.admin.id],
    actorId: fx.admin.id,
    category: 'system' as const,
    titleKey: 'notifications.tpl.automation',
    params: { text },
    channels: ['app' as const, 'email' as const, 'telegram' as const],
    direct: true,
  }
}

describe('уведомление многим получателям', () => {
  it('строки — всем, внешний канал — одной пачкой после записи, настройки соблюдены', async () => {
    const text = `Пачка ${run}`
    const started = performance.now()
    await NotificationService.notify(notice(text))
    const elapsed = performance.now() - started
    // biome-ignore lint/suspicious/noConsole: замеры времени нужны в журнале прогона
    console.info(
      `уведомление ${COUNT} получателям: ${elapsed.toFixed(0)} мс, пачек Telegram ${batches.length}`,
    )

    const rows = await rowsOf(text)
    expect(rows.map((row) => row.user_id).sort()).toEqual([...recipients].sort())
    expect(batches).toHaveLength(1)
    expect(rowsAtDelivery, 'канал вызывается, когда все строки уже записаны').toBe(COUNT)
    const telegram = batches[0]?.map((message) => message.userId) ?? []
    expect(telegram).toHaveLength(COUNT - 1)
    expect(telegram).not.toContain(recipients[1])
    expect(rows.filter((row) => row.external_sent_at !== null)).toHaveLength(COUNT - 1)
  })

  it('повтор в окне агрегации — счётчик у всех, без новых строк и сообщений', async () => {
    const text = `Пачка ${run}`
    batches.length = 0
    await NotificationService.notify(notice(text))
    const rows = await rowsOf(text)
    expect(rows).toHaveLength(COUNT)
    expect(new Set(rows.map((row) => row.aggregate_count))).toEqual(new Set([2]))
    expect(batches).toHaveLength(0)
  })
})
