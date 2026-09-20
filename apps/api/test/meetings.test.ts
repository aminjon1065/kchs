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
 * Встречи и звонки (P4-E02 S01, ADR-0089): встреча — объект реестра,
 * приглашённые видят её участием, вход в комнату выдаёт токен медиасервера с
 * правами участника. Без ключей медиасервера функция выключена: статус
 * сообщает об этом, вход отвечает «сервис недоступен».
 */
registerLifecycle()

const { MeetingService } = await import('../src/modules/meetings/domain/meeting-service.js')
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

/** Полезная нагрузка токена комнаты: JWT без проверки подписи. */
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

beforeAll(async () => {
  fx = await setupFixture()
  organizer = await createUser(fx.app, `meet_org_${run}`, ['employee'])
  member = await createUser(fx.app, `meet_member_${run}`, ['employee'])
  outsider = await createUser(fx.app, `meet_out_${run}`, ['employee'])
})

afterAll(() => {
  withMedia(false)
})

describe('медиасервер не настроен', () => {
  it('статус выключен, звонок не поднимается', async () => {
    withMedia(false)
    const status = await call(fx.app, { url: '/meetings/status', as: organizer })
    expect(status.statusCode, status.body).toBe(200)
    expect(status.json()).toEqual({ enabled: false, url: null })

    const created = await call(fx.app, {
      method: 'POST',
      url: '/meetings',
      as: organizer,
      payload: { title: `Звонок без сервера ${run}`, participantIds: [member.id] },
    })
    expect(created.statusCode, created.body).toBe(200)
    // Встреча заводится, но войти нельзя — кнопки входа в интерфейсе нет
    expect(created.json().can.join).toBe(false)
    const join = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${created.json().id}/join`,
      as: organizer,
    })
    expect(join.statusCode, join.body).toBe(503)
    expect(join.json().code).toBe('service_unavailable')
  })
})

describe('звонок из беседы', () => {
  let meetingId = ''

  it('участники видят встречу, посторонний — нет; статус включён', async () => {
    withMedia(true)
    const status = await call(fx.app, { url: '/meetings/status', as: organizer })
    expect(status.json()).toEqual({ enabled: true, url: MEDIA.LIVEKIT_URL })

    const created = await call(fx.app, {
      method: 'POST',
      url: '/meetings',
      as: organizer,
      payload: { title: `Обсудить паводок ${run}`, participantIds: [member.id] },
    })
    expect(created.statusCode, created.body).toBe(200)
    const record = created.json() as Json
    meetingId = record.id
    expect(record).toMatchObject({ kind: 'call', status: 'planned', inRoom: 0 })
    expect(record.roomName).toBe(`meeting-${meetingId}`)
    expect(record.organizer.id).toBe(organizer.id)
    expect(record.participants.map((item: Json) => item.user.id).sort()).toEqual(
      [organizer.id, member.id].sort(),
    )
    expect(record.can).toMatchObject({ join: true, manage: true, end: true, record: false })

    const asMember = await call(fx.app, { url: `/meetings/${meetingId}`, as: member })
    expect(asMember.statusCode, asMember.body).toBe(200)
    // Приглашённый входит, но не ведёт встречу
    expect(asMember.json().can).toMatchObject({ join: true, manage: false, end: false })
    const asOutsider = await call(fx.app, { url: `/meetings/${meetingId}`, as: outsider })
    expect(asOutsider.statusCode).toBe(404)

    // Приглашённым ушло событие входящего звонка
    const events = await db().execute<{ type: string; event: Json }>(
      sql`SELECT type, event FROM ops.outbox
           WHERE event->'object'->>'id' = ${meetingId} ORDER BY id`,
    )
    const incoming = events.find((row) => row.type === 'call.incoming')
    expect(incoming?.event.payload).toMatchObject({ userIds: [member.id] })
  })

  it('вход в комнату: токен с правами участника, встреча идёт', async () => {
    const join = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/join`,
      as: member,
    })
    expect(join.statusCode, join.body).toBe(200)
    const payload = tokenPayload(join.json().token)
    expect(join.json()).toMatchObject({
      meetingId,
      roomName: `meeting-${meetingId}`,
      url: MEDIA.LIVEKIT_URL,
      identity: member.id,
      canPublish: true,
      canRecord: false,
    })
    expect(payload.sub).toBe(member.id)
    expect(payload.video).toMatchObject({
      room: `meeting-${meetingId}`,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      roomRecord: false,
    })
    expect(payload.exp - payload.nbf).toBe(3600)

    const record = await call(fx.app, { url: `/meetings/${meetingId}`, as: organizer })
    expect(record.json()).toMatchObject({ status: 'live', inRoom: 1 })
    expect(record.json().startedAt).not.toBeNull()

    // Посторонний в комнату не входит
    const stranger = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/join`,
      as: outsider,
    })
    expect(stranger.statusCode).toBe(404)
  })

  it('выход из комнаты и завершение встречи организатором', async () => {
    const left = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/leave`,
      as: member,
    })
    expect(left.statusCode, left.body).toBe(200)
    const afterLeave = await call(fx.app, { url: `/meetings/${meetingId}`, as: organizer })
    expect(afterLeave.json().inRoom).toBe(0)

    // Завершает только тот, кто ведёт встречу
    const byMember = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/end`,
      as: member,
    })
    expect(byMember.statusCode).toBe(403)

    // Организатор всё ещё в комнате: завершение выпускает его выход, иначе
    // присутствие навсегда оставит его «на встрече»
    await call(fx.app, { method: 'POST', url: `/meetings/${meetingId}/join`, as: organizer })
    const ended = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/end`,
      as: organizer,
    })
    expect(ended.statusCode, ended.body).toBe(200)
    const leftEvents = await db().execute<{ type: string; event: Json }>(
      sql`SELECT type, event FROM ops.outbox
           WHERE event->'object'->>'id' = ${meetingId} AND type = 'meeting.participant_left'`,
    )
    expect(leftEvents.map((row) => row.event.payload.userId)).toContain(organizer.id)
    expect(ended.json()).toMatchObject({ status: 'ended', can: { join: false, end: false } })
    expect(ended.json().endedAt).not.toBeNull()

    const again = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/join`,
      as: member,
    })
    expect(again.statusCode).toBe(409)
  })

  it('гость по ссылке: короткий токен комнаты без права записи', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/meetings',
      as: organizer,
      payload: { title: `Встреча с гостем ${run}`, participantIds: [] },
    })
    const id = created.json().id as string
    const guest = await MeetingService.guestToken(id, { name: 'Гость Рахимов' })
    const payload = tokenPayload(guest.token)
    expect(guest.identity.startsWith('guest:')).toBe(true)
    expect(guest.displayName).toBe('Гость Рахимов')
    expect(payload.video).toMatchObject({ room: `meeting-${id}`, roomRecord: false })
    expect(payload.exp - payload.nbf).toBe(900)
    expect(JSON.parse(payload.metadata as string)).toMatchObject({ meetingId: id, guest: true })
  })

  it('администратор со способностью записи получает право записи в токене', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/meetings',
      as: fx.admin,
      payload: { title: `Запись совещания ${run}`, participantIds: [] },
    })
    const id = created.json().id as string
    expect(created.json().can.record).toBe(true)
    const join = await call(fx.app, { method: 'POST', url: `/meetings/${id}/join`, as: fx.admin })
    expect(join.json().canRecord).toBe(true)
    expect(tokenPayload(join.json().token).video.roomRecord).toBe(true)
  })

  it('список встреч: мои и идущие', async () => {
    // Ограничение приходит строкой запроса — контракт приводит его к числу
    const limited = await call(fx.app, { url: '/meetings?scope=mine&limit=5', as: organizer })
    expect(limited.statusCode, limited.body).toBe(200)
    expect((limited.json().items as Json[]).length).toBeLessThanOrEqual(5)

    const mine = await call(fx.app, { url: '/meetings?scope=mine', as: organizer })
    expect(mine.statusCode, mine.body).toBe(200)
    const titles = (mine.json().items as Json[]).map((item) => item.title)
    expect(titles).toContain(`Встреча с гостем ${run}`)
    const memberList = await call(fx.app, { url: '/meetings?scope=mine', as: member })
    expect((memberList.json().items as Json[]).map((item) => item.title)).not.toContain(
      `Встреча с гостем ${run}`,
    )
  })
})

describe('встреча события календаря', () => {
  it('включается флагом, участники идут за участниками события, отмена закрывает комнату', async () => {
    withMedia(true)
    const starts = new Date(Date.now() + 3_600_000).toISOString()
    const ends = new Date(Date.now() + 5_400_000).toISOString()
    const created = await call(fx.app, {
      method: 'POST',
      url: '/events',
      as: organizer,
      payload: {
        title: `Совещание по паводку ${run}`,
        startsAt: starts,
        endsAt: ends,
        attendees: [{ userId: member.id }],
        onlineMeeting: true,
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const eventId = created.json().id as string
    const event = await call(fx.app, { url: `/events/${eventId}`, as: organizer })
    const meetingId = event.json().meetingId as string
    expect(meetingId).toBeTruthy()

    const meeting = await call(fx.app, { url: `/meetings/${meetingId}`, as: member })
    expect(meeting.statusCode, meeting.body).toBe(200)
    expect(meeting.json()).toMatchObject({ kind: 'scheduled', status: 'planned', eventId })
    expect(
      meeting
        .json()
        .participants.map((item: Json) => item.user.id)
        .sort(),
    ).toEqual([organizer.id, member.id].sort())
    expect(meeting.json().startsAt).toBe(starts)

    // Участник исключён из события — теряет и встречу
    const updated = await call(fx.app, {
      method: 'PATCH',
      url: `/events/${eventId}`,
      as: organizer,
      payload: { attendees: [] },
    })
    expect(updated.statusCode, updated.body).toBe(200)
    const afterRemove = await call(fx.app, { url: `/meetings/${meetingId}`, as: member })
    expect(afterRemove.statusCode).toBe(404)

    // Событие отменено — встреча закрыта
    const cancelled = await call(fx.app, {
      method: 'POST',
      url: `/events/${eventId}/cancel`,
      as: organizer,
      payload: { scope: 'series' },
    })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    const ended = await call(fx.app, { url: `/meetings/${meetingId}`, as: organizer })
    expect(ended.json().status).toBe('cancelled')
  })

  it('онлайн-встречу можно выключить правкой события', async () => {
    withMedia(true)
    const created = await call(fx.app, {
      method: 'POST',
      url: '/events',
      as: organizer,
      payload: {
        title: `Планёрка ${run}`,
        startsAt: new Date(Date.now() + 7_200_000).toISOString(),
        endsAt: new Date(Date.now() + 9_000_000).toISOString(),
        onlineMeeting: true,
      },
    })
    const eventId = created.json().id as string
    const meetingId = (await call(fx.app, { url: `/events/${eventId}`, as: organizer })).json()
      .meetingId as string
    const off = await call(fx.app, {
      method: 'PATCH',
      url: `/events/${eventId}`,
      as: organizer,
      payload: { onlineMeeting: false },
    })
    expect(off.statusCode, off.body).toBe(200)
    const event = await call(fx.app, { url: `/events/${eventId}`, as: organizer })
    expect(event.json().meetingId).toBeNull()
    const meeting = await call(fx.app, { url: `/meetings/${meetingId}`, as: organizer })
    expect(meeting.json().status).toBe('cancelled')
  })
})
