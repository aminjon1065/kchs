import type { AddressInfo } from 'node:net'
import { sql } from 'drizzle-orm'
import { io as connectSocket, type Socket } from 'socket.io-client'
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
 * Сообщения встреч вне комнаты (ADR-0193): гость в комнате ожидания — открытой комнате встречи
 * заявкой без имени и ведущему, где бы он ни был; отказ от звонка — звонящему. Доставляет
 * подписчик встреч по событию outbox, клиент — настоящий socket.io-client.
 */
registerLifecycle()

const gateway = await import('../src/kernel/realtime/gateway.js')
const { listSubscribers } = await import('../src/kernel/events/bus.js')
const { AuthService } = await import('../src/modules/identity/public.js')
const { registerMeetingRealtime } = await import(
  '../src/modules/meetings/domain/meeting-subscribers.js'
)
const { resetConfigCache } = await import('../src/shared/config/index.js')

const run = Date.now().toString(36)
const MEDIA = {
  LIVEKIT_URL: 'ws://127.0.0.1:7880',
  LIVEKIT_API_KEY: `key_${run}`,
  LIVEKIT_API_SECRET: 'secret_for_tests_at_least_32_characters_long',
}

let fx: TestContext
let base: string
let organizer: TestUser
let member: TestUser
const opened: Socket[] = []

// biome-ignore lint/suspicious/noExplicitAny: нагрузки событий в тестах — без приведения типов
type Json = any

function withMedia(on: boolean): void {
  for (const [key, value] of Object.entries(MEDIA)) {
    if (on) process.env[key] = value
    else delete process.env[key]
  }
  resetConfigCache()
}

function connect(user: TestUser): Promise<Socket> {
  const socket = connectSocket(base, {
    path: '/ws',
    transports: ['websocket'],
    extraHeaders: { cookie: user.cookie },
    reconnection: false,
  })
  opened.push(socket)
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket))
    socket.once('connect_error', reject)
  })
}

/** Все сообщения события на сокете — чтобы проверить и пришедшее, и не пришедшее. */
function collect(socket: Socket, event: string): Json[] {
  const received: Json[] = []
  socket.on(event, (payload: Json) => received.push(payload))
  return received
}

/** Первое сообщение события, подошедшее под условие; без него за отведённое время — ошибка. */
function next(socket: Socket, event: string, matches: (payload: Json) => boolean): Promise<Json> {
  return new Promise((resolve, reject) => {
    const listener = (payload: Json) => {
      if (!matches(payload)) return
      clearTimeout(timer)
      socket.off(event, listener)
      resolve(payload)
    }
    const timer = setTimeout(() => {
      socket.off(event, listener)
      reject(new Error(`нет события ${event}`))
    }, 5_000)
    socket.on(event, listener)
  })
}

/** Событие встречи из outbox — подписчику встреч, как это делает воркер. */
async function deliver(type: string, meetingId: string): Promise<void> {
  const [row] = await db().execute<{ event: Json }>(
    sql`SELECT event FROM ops.outbox
         WHERE type = ${type} AND event->'object'->>'id' = ${meetingId}
         ORDER BY id DESC LIMIT 1`,
  )
  expect(row, `событие ${type}`).toBeTruthy()
  const subscriber = listSubscribers().find((item) => item.name === 'meetings-realtime')
  if (!subscriber) throw new Error('подписчик встреч не зарегистрирован')
  await subscriber.handle(row?.event)
}

async function startMeeting(title: string): Promise<string> {
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
  organizer = await createUser(fx.app, `signal_org_${run}`, ['employee'])
  member = await createUser(fx.app, `signal_member_${run}`, ['employee'])
  if (!listSubscribers().some((item) => item.name === 'meetings-realtime')) {
    registerMeetingRealtime()
  }
  withMedia(true)
  await fx.app.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${(fx.app.server.address() as AddressInfo).port}`
  gateway.startRealtime(fx.app, {
    resolveSession: (token) => AuthService.resolveSession(token),
    accessAttributesOf: (session) => AuthService.accessAttributesOf(session),
  })
})

afterAll(() => {
  for (const socket of opened.splice(0)) socket.disconnect()
  gateway.stopRealtime()
  withMedia(false)
})

describe('гость в комнате ожидания', () => {
  it('ведущему — кто и куда просится, открытой комнате — заявка без имени', async () => {
    const title = `Встреча с подрядчиком ${run}`
    const meetingId = await startMeeting(title)
    const link = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/guest-link`,
      as: organizer,
      payload: { ttlMinutes: 60 },
    })
    expect(link.statusCode, link.body).toBe(200)
    const token = (link.json().url as string).split('/meet/')[1] as string

    const host = await connect(organizer)
    const participant = await connect(member)
    // Комнату встречи участник открыл — он подписан на комнату её объекта
    const ack = await participant.emitWithAck('subscribe', { rooms: [`object:${meetingId}`] })
    expect(ack.granted).toEqual([`object:${meetingId}`])
    const participantSignals = collect(participant, 'meeting.guest_waiting')

    const knock = await call(fx.app, {
      method: 'POST',
      url: `/meetings/guest/${token}/join`,
      payload: { name: 'Гость Рахимов' },
    })
    expect(knock.statusCode, knock.body).toBe(200)
    const requestId = knock.json().requestId as string

    const signal = next(host, 'meeting.guest_waiting', (payload) => payload.requestId === requestId)
    const roomKnock = next(
      participant,
      'meeting.knock',
      (payload) => payload.requestId === requestId,
    )
    await deliver('meeting.guest_waiting', meetingId)

    expect(await signal).toEqual({ meetingId, requestId, name: 'Гость Рахимов', title })
    // Имени гостя в комнате объекта нет: заявки видит только ведущий
    expect(await roomKnock).toEqual({ meetingId, requestId })
    expect(participantSignals).toEqual([])
  })
})

describe('отказ от звонка', () => {
  it('звонящему — кто отклонил; самому отклонившему — ничего', async () => {
    const meetingId = await startMeeting(`Звонок с отказом ${run}`)
    const caller = await connect(organizer)
    const callee = await connect(member)
    const calleeSignals = collect(callee, 'call.declined')

    const declined = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/decline`,
      as: member,
    })
    expect(declined.statusCode, declined.body).toBe(200)

    const signal = next(caller, 'call.declined', (payload) => payload.meetingId === meetingId)
    await deliver('call.declined', meetingId)

    expect(await signal).toMatchObject({ meetingId, user: { id: member.id } })
    expect(calleeSignals).toEqual([])
  })
})
