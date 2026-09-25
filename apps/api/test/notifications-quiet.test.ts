import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Тишина получателя (05-risks N23, ADR-0140): «не беспокоить», тихие часы и встреча глушат
 * внешние каналы — Telegram, push и письма — у всех уведомлений, кроме срочных. Значок в
 * приложении остаётся, письмо «немедленно» ждёт дайджеста, а дайджест — конца тишины.
 */
registerLifecycle()

const { NotificationService, sendEmailDigest } = await import(
  '../src/kernel/notifications/service.js'
)
const { notificationChannel, setNotificationChannel } = await import(
  '../src/kernel/notifications/channels.js'
)
const { registerChatQuietHours } = await import('../src/modules/chat/module.js')
const { PresenceService } = await import('../src/modules/chat/domain/presence.js')
const { buildUserCtxFor } = await import('../src/kernel/access/explain.js')
const { notifications, userPresence } = await import('../src/shared/db/schema/index.js')
const { mailConfigured } = await import('../src/shared/mail/index.js')

const run = Date.now().toString(36)
let fx: TestContext
const delivered: Array<{ userId: string; text: string }> = []
const previousTelegram = notificationChannel('telegram')

/** Строки уведомлений прогона по тексту: каналы и отметка отправки письма. */
async function rowsOf(text: string) {
  return db()
    .select({
      userId: notifications.userId,
      channels: notifications.channels,
      emailedAt: notifications.emailedAt,
    })
    .from(notifications)
    .where(sql`${notifications.params}->>'text' = ${text}`)
}

async function presence(input: Parameters<typeof PresenceService.update>[1]) {
  const ctx = await buildUserCtxFor(fx.users.member.id)
  if (!ctx) throw new Error('нет контекста сотрудника')
  await PresenceService.update(ctx, input)
}

/** Тихие часы вокруг текущего момента в поясе сотрудника (Asia/Dushanbe). */
function hoursAroundNow(): { enabled: boolean; from: string; to: string } {
  const local = (offsetMinutes: number) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dushanbe',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(Date.now() + offsetMinutes * 60_000))
  return { enabled: true, from: local(-60), to: local(60) }
}

const telegramTo = (userId: string, text: string) =>
  delivered.some((item) => item.userId === userId && item.text.includes(text))

beforeAll(async () => {
  fx = await setupFixture()
  registerChatQuietHours()
  // Telegram «привязан» у всех: доставка копится в памяти теста
  setNotificationChannel('telegram', {
    available: async (userIds) => new Set(userIds),
    deliver: async (messages) => {
      for (const message of messages) delivered.push({ userId: message.userId, text: message.text })
    },
  })
})

afterAll(() => {
  if (previousTelegram) setNotificationChannel('telegram', previousTelegram)
})

beforeEach(async () => {
  await db().delete(userPresence).where(eq(userPresence.userId, fx.users.member.id))
})

describe('тишина получателя', () => {
  it('«не беспокоить» глушит Telegram, срочное проходит', async () => {
    await presence({ status: 'dnd' })
    const quiet = `Назначено поручение ${run}`
    await NotificationService.notify({
      userIds: [fx.users.member.id],
      category: 'tasks',
      titleKey: 'notifications.tpl.automation',
      params: { text: quiet },
      aggregateKey: quiet,
    })
    expect(telegramTo(fx.users.member.id, quiet)).toBe(false)
    const [row] = await rowsOf(quiet)
    expect(row?.channels).toContain('app')
    expect(row?.channels).not.toContain('telegram')

    const urgent = `Алерт ЧС ${run}`
    await NotificationService.notify({
      userIds: [fx.users.member.id],
      category: 'tasks',
      titleKey: 'notifications.tpl.automation',
      params: { text: urgent },
      aggregateKey: urgent,
      urgent: true,
    })
    expect(telegramTo(fx.users.member.id, urgent)).toBe(true)
  })

  it('явно выбранный канал без срочности уходит в приложение, а не теряется', async () => {
    await presence({ status: 'dnd' })
    const text = `Сообщение правила ${run}`
    await NotificationService.notify({
      userIds: [fx.users.member.id],
      category: 'system',
      titleKey: 'notifications.tpl.automation',
      params: { text },
      aggregateKey: text,
      channels: ['telegram'],
      direct: true,
    })
    expect(telegramTo(fx.users.member.id, text)).toBe(false)
    const [row] = await rowsOf(text)
    expect(row?.channels).toEqual(['app'])

    // Без тишины тот же явный канал доставляется сразу, мимо умолчаний категории
    await db().delete(userPresence).where(eq(userPresence.userId, fx.users.member.id))
    const loud = `Сообщение правила днём ${run}`
    await NotificationService.notify({
      userIds: [fx.users.member.id],
      category: 'system',
      titleKey: 'notifications.tpl.automation',
      params: { text: loud },
      aggregateKey: loud,
      channels: ['telegram'],
      direct: true,
    })
    expect(telegramTo(fx.users.member.id, loud)).toBe(true)
  })

  it('тихие часы: письмо «немедленно» ждёт дайджеста, дайджест — конца тишины', async () => {
    await presence({ quietHours: hoursAroundNow() })
    expect(await PresenceService.quietUsers([fx.users.member.id])).toEqual(
      new Set([fx.users.member.id]),
    )
    const text = `Резолюция ночью ${run}`
    // «Входящие» по умолчанию шлют письмо сразу — в тишине оно переходит в дайджест
    await NotificationService.notify({
      userIds: [fx.users.member.id],
      category: 'inbox',
      titleKey: 'notifications.tpl.automation',
      params: { text },
      aggregateKey: text,
    })
    const [quietRow] = await rowsOf(text)
    expect(quietRow?.channels).toContain('email')
    expect(quietRow?.emailedAt).toBeNull()
    expect(telegramTo(fx.users.member.id, text)).toBe(false)

    await sendEmailDigest(0)
    const [waiting] = await rowsOf(text)
    expect(waiting?.emailedAt).toBeNull()

    if (mailConfigured()) {
      // Тишина кончилась — дайджест отправляет накопленное
      await presence({ quietHours: { enabled: false, from: '21:00', to: '08:00' } })
      await sendEmailDigest(0)
      const [sent] = await rowsOf(text)
      expect(sent?.emailedAt).not.toBeNull()
    }
  })

  it('встреча — тоже тишина; после неё каналы возвращаются', async () => {
    await PresenceService.setInMeeting(fx.users.member.id, true)
    const text = `Во время встречи ${run}`
    await NotificationService.notify({
      userIds: [fx.users.member.id],
      category: 'tasks',
      titleKey: 'notifications.tpl.automation',
      params: { text },
      aggregateKey: text,
    })
    expect(telegramTo(fx.users.member.id, text)).toBe(false)

    await PresenceService.setInMeeting(fx.users.member.id, false)
    const after = `После встречи ${run}`
    await NotificationService.notify({
      userIds: [fx.users.member.id],
      category: 'tasks',
      titleKey: 'notifications.tpl.automation',
      params: { text: after },
      aggregateKey: after,
    })
    expect(telegramTo(fx.users.member.id, after)).toBe(true)
    const rows = await db()
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, fx.users.member.id)))
    expect(rows.length).toBeGreaterThan(0)
  })
})
