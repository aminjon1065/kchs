import { MeetingSignal } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Комната встречи и звонки (P4-E02 S02–S04, ADR-0091): ссылка для гостя и её
 * границы, комната ожидания, вход во встречу события календаря, отказ от
 * звонка и поведение без медиасервера.
 */
registerLifecycle()

const { resetConfigCache } = await import('../src/shared/config/index.js')

const run = Date.now().toString(36)
const MEDIA = {
  LIVEKIT_URL: 'ws://127.0.0.1:7880',
  LIVEKIT_API_KEY: `key_${run}`,
  LIVEKIT_API_SECRET: 'secret_for_tests_at_least_32_characters_long',
}

let fx: TestContext
let organizer: TestUser
let member: TestUser
let outsider: TestUser

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Json = any

function tokenPayload(token: string): Json {
  const [, payload] = token.split('.')
  return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'))
}

function withMedia(on: boolean): void {
  for (const [key, value] of Object.entries(MEDIA)) {
    if (on) process.env[key] = value
    else delete process.env[key]
  }
  resetConfigCache()
}

/** Звонок, поднятый организатором: участники — он и `member`. */
async function startCall(title: string): Promise<string> {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/meetings',
    as: organizer,
    payload: { title, participantIds: [member.id] },
  })
  expect(created.statusCode, created.body).toBe(200)
  return created.json().id as string
}

beforeAll(async () => {
  fx = await setupFixture()
  organizer = await createUser(fx.app, `room_org_${run}`, ['employee'])
  member = await createUser(fx.app, `room_member_${run}`, ['employee'])
  outsider = await createUser(fx.app, `room_out_${run}`, ['employee'])
  withMedia(true)
})

afterAll(() => {
  withMedia(false)
})

describe('гостевая ссылка', () => {
  let meetingId = ''
  let url = ''

  it('создаёт только ведущий встречу', async () => {
    meetingId = await startCall(`Встреча с подрядчиком ${run}`)

    const byMember = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/guest-link`,
      as: member,
      payload: { ttlMinutes: 60 },
    })
    expect(byMember.statusCode).toBe(403)

    const byOutsider = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/guest-link`,
      as: outsider,
      payload: { ttlMinutes: 60 },
    })
    expect(byOutsider.statusCode).toBe(404)

    const created = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/guest-link`,
      as: organizer,
      payload: { ttlMinutes: 60 },
    })
    expect(created.statusCode, created.body).toBe(200)
    url = created.json().url as string
    expect(url).toContain('/meet/')
    expect(Date.parse(created.json().expiresAt as string)).toBeGreaterThan(Date.now())
  })

  it('гость видит только название встречи, объекты ему недоступны', async () => {
    const token = url.slice(url.indexOf('/meet/') + '/meet/'.length)
    const preview = await call(fx.app, { url: `/meetings/guest/${token}` })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toEqual({
      title: `Встреча с подрядчиком ${run}`,
      status: 'planned',
      enabled: true,
    })

    // Ни объект встречи, ни её карточка гостю не открываются: сессии у него нет
    const asAnonymous = await call(fx.app, { url: `/meetings/${meetingId}` })
    expect(asAnonymous.statusCode).toBe(401)
    const objectRead = await call(fx.app, { url: `/objects/${meetingId}` })
    expect(objectRead.statusCode).toBe(401)
  })

  it('подпись и срок ссылки проверяются', async () => {
    const token = url.slice(url.indexOf('/meet/') + '/meet/'.length)
    const [id, exp, signature] = token.split('.')
    const broken = await call(fx.app, { url: `/meetings/guest/${id}.${exp}.${signature}x` })
    expect(broken.statusCode).toBe(404)

    // Подпись верна, но срок в прошлом — ссылку подменили
    const expired = await call(fx.app, {
      url: `/meetings/guest/${id}.${Math.floor(Date.now() / 1000) - 10}.${signature}`,
    })
    expect(expired.statusCode).toBe(404)
  })

  it('комната ожидания: заявка, решение ведущего, короткий токен гостю', async () => {
    const token = url.slice(url.indexOf('/meet/') + '/meet/'.length)
    const knock = await call(fx.app, {
      method: 'POST',
      url: `/meetings/guest/${token}/join`,
      payload: { name: 'Гость Рахимов' },
    })
    expect(knock.statusCode, knock.body).toBe(200)
    expect(knock.json()).toMatchObject({ state: 'waiting', join: null })
    const requestId = knock.json().requestId as string

    // Заявку видит только тот, кто ведёт встречу
    const byMember = await call(fx.app, { url: `/meetings/${meetingId}/knocks`, as: member })
    expect(byMember.statusCode).toBe(403)

    const pending = await call(fx.app, { url: `/meetings/${meetingId}/knocks`, as: organizer })
    expect(pending.statusCode, pending.body).toBe(200)
    expect(pending.json().items).toMatchObject([{ id: requestId, name: 'Гость Рахимов' }])

    // Пока решения нет — гость ждёт
    const stillWaiting = await call(fx.app, {
      method: 'POST',
      url: `/meetings/guest/${token}/join`,
      payload: { name: 'Гость Рахимов', requestId },
    })
    expect(stillWaiting.json().state).toBe('waiting')

    const admitted = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/knocks/${requestId}`,
      as: organizer,
      payload: { admit: true },
    })
    expect(admitted.statusCode, admitted.body).toBe(200)

    const entered = await call(fx.app, {
      method: 'POST',
      url: `/meetings/guest/${token}/join`,
      payload: { name: 'Гость Рахимов', requestId },
    })
    expect(entered.statusCode, entered.body).toBe(200)
    expect(entered.json().state).toBe('admitted')
    const join = entered.json().join as Json
    expect(join.identity.startsWith('guest:')).toBe(true)
    expect(join.canRecord).toBe(false)
    const payload = tokenPayload(join.token)
    expect(payload.video).toMatchObject({ room: `meeting-${meetingId}`, roomRecord: false })
    expect(payload.exp - payload.nbf).toBe(900)
    expect(JSON.parse(payload.metadata as string)).toMatchObject({ guest: true })

    // Впущенный гость обновляет токен той же заявкой — переподключение
    const again = await call(fx.app, {
      method: 'POST',
      url: `/meetings/guest/${token}/join`,
      payload: { name: 'Гость Рахимов', requestId },
    })
    expect(again.json().join.token).not.toBe(join.token)

    // Решение видно и в списке: заявка больше не ждёт
    const after = await call(fx.app, { url: `/meetings/${meetingId}/knocks`, as: organizer })
    expect(after.json().items).toEqual([])
  })

  it('отказ ведущего закрывает вход', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/guest-link`,
      as: organizer,
      payload: { ttlMinutes: 60 },
    })
    const token = (created.json().url as string).split('/meet/')[1] as string
    const knock = await call(fx.app, {
      method: 'POST',
      url: `/meetings/guest/${token}/join`,
      payload: { name: 'Нежданный гость' },
    })
    const requestId = knock.json().requestId as string
    await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/knocks/${requestId}`,
      as: organizer,
      payload: { admit: false },
    })
    const denied = await call(fx.app, {
      method: 'POST',
      url: `/meetings/guest/${token}/join`,
      payload: { name: 'Нежданный гость', requestId },
    })
    expect(denied.json()).toMatchObject({ state: 'denied', join: null })
  })

  it('завершённая встреча гостя не впускает', async () => {
    await call(fx.app, { method: 'POST', url: `/meetings/${meetingId}/end`, as: organizer })
    const token = url.slice(url.indexOf('/meet/') + '/meet/'.length)
    const preview = await call(fx.app, { url: `/meetings/guest/${token}` })
    expect(preview.json().status).toBe('ended')
    const attempt = await call(fx.app, {
      method: 'POST',
      url: `/meetings/guest/${token}/join`,
      payload: { name: 'Поздний гость' },
    })
    // Заявка принята, но токена комнаты завершённая встреча не даёт
    expect(attempt.json().join).toBeNull()
  })
})

describe('входящий звонок', () => {
  it('отказ приглашённого публикует событие звонящему', async () => {
    const meetingId = await startCall(`Звонок с отказом ${run}`)
    const declined = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/decline`,
      as: member,
    })
    expect(declined.statusCode, declined.body).toBe(200)

    const events = await db().execute<{ type: string; event: Json }>(
      sql`SELECT type, event FROM ops.outbox WHERE event->'object'->>'id' = ${meetingId} ORDER BY id`,
    )
    const event = events.find((row) => row.type === 'call.declined')
    expect(event?.event.payload).toMatchObject({
      meetingId,
      userId: member.id,
      callerId: organizer.id,
    })

    // Отказ не закрывает звонок: другие участники ещё могут войти
    const record = await call(fx.app, { url: `/meetings/${meetingId}`, as: organizer })
    expect(record.json().status).toBe('planned')

    // Посторонний отклонить чужой звонок не может
    const byOutsider = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/decline`,
      as: outsider,
    })
    expect(byOutsider.statusCode).toBe(404)
  })
})

describe('встреча по расписанию', () => {
  it('участник события входит в комнату из карточки события', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/events',
      as: organizer,
      payload: {
        title: `Планёрка комнаты ${run}`,
        startsAt: new Date(Date.now() + 3_600_000).toISOString(),
        endsAt: new Date(Date.now() + 5_400_000).toISOString(),
        attendees: [{ userId: member.id }],
        onlineMeeting: true,
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const eventId = created.json().id as string

    // Приглашённый видит встречу события у себя и входит в комнату
    const event = await call(fx.app, { url: `/events/${eventId}`, as: member })
    const meetingId = event.json().meetingId as string
    expect(meetingId).toBeTruthy()

    const join = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/join`,
      as: member,
    })
    expect(join.statusCode, join.body).toBe(200)
    expect(join.json()).toMatchObject({ meetingId, identity: member.id, canPublish: true })

    const record = await call(fx.app, { url: `/meetings/${meetingId}`, as: member })
    expect(record.json()).toMatchObject({ kind: 'scheduled', status: 'live', eventId })

    // Встреча события видна в списке «мои»
    const mine = await call(fx.app, { url: '/meetings?scope=live', as: member })
    expect((mine.json().items as Json[]).map((item) => item.id)).toContain(meetingId)
  })
})

describe('«показать всем» — сигнал между клиентами', () => {
  it('контракт сигнала принимает объект и отвергает мусор', () => {
    const ok = MeetingSignal.safeParse({
      type: 'show',
      objectId: '0199a0f0-0000-7000-8000-000000000000',
      objectType: 'dashboard',
      title: 'Паводок: сводка',
    })
    expect(ok.success).toBe(true)
    expect(MeetingSignal.safeParse({ type: 'show', objectId: 'нет' }).success).toBe(false)
    expect(MeetingSignal.safeParse({ type: 'hand', raised: true }).success).toBe(true)
    expect(MeetingSignal.safeParse({ type: 'unknown' }).success).toBe(false)
  })
})

describe('медиасервер не настроен', () => {
  it('ссылки для гостя нет, вход гостя недоступен', async () => {
    const meetingId = await startCall(`Звонок без медиасервера ${run}`)
    const link = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/guest-link`,
      as: organizer,
      payload: { ttlMinutes: 60 },
    })
    const token = (link.json().url as string).split('/meet/')[1] as string

    withMedia(false)
    try {
      const guestLink = await call(fx.app, {
        method: 'POST',
        url: `/meetings/${meetingId}/guest-link`,
        as: organizer,
        payload: { ttlMinutes: 60 },
      })
      expect(guestLink.statusCode).toBe(503)

      const preview = await call(fx.app, { url: `/meetings/guest/${token}` })
      expect(preview.json().enabled).toBe(false)

      const knock = await call(fx.app, {
        method: 'POST',
        url: `/meetings/guest/${token}/join`,
        payload: { name: 'Гость без сервера' },
      })
      expect(knock.statusCode).toBe(503)
      expect(knock.json().code).toBe('service_unavailable')
    } finally {
      withMedia(true)
    }
  })
})
