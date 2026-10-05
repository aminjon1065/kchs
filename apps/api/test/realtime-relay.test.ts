import type { AddressInfo } from 'node:net'
import { io as connectSocket, type Socket } from 'socket.io-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Ретрансляция realtime (01-overview.md §Realtime): подписчики событий работают в
 * worker, у которого нет шлюза, а сокеты открыты на узлах api. Процесс без шлюза
 * публикует команду в канал Redis, узел api доставляет её своим сокетам и сам
 * перепроверяет права при отзыве. Клиент — настоящий socket.io-client, сервер —
 * api на случайном порту.
 */
registerLifecycle()

const gateway = await import('../src/kernel/realtime/gateway.js')
const { AuthService } = await import('../src/modules/identity/public.js')
const { createRedisConnection } = await import('../src/shared/redis/index.js')

let fx: TestContext
let base: string
const run = Date.now().toString(36)
const opened: Socket[] = []

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

/** Следующее событие сокета; без него за отведённое время — ошибка. */
function next<T>(socket: Socket, event: string, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`нет события ${event}`)), timeoutMs)
    socket.once(event, (payload: T) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

beforeAll(async () => {
  fx = await setupFixture()
  await fx.app.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${(fx.app.server.address() as AddressInfo).port}`
})

afterAll(() => {
  for (const socket of opened.splice(0)) socket.disconnect()
  gateway.stopRealtime()
})

describe('процесс без шлюза (worker)', () => {
  it('отправляет сообщение комнате через канал ретрансляции', async () => {
    const listener = createRedisConnection('test-relay')
    await listener.subscribe(gateway.RELAY_CHANNEL)
    const room = `user:${fx.users.member.id}`
    // В канал пишут и другие процессы стенда — ждём своё сообщение
    const received = new Promise<unknown>((resolve) => {
      listener.on('message', (_channel, message) => {
        const command = JSON.parse(message) as { room?: string }
        if (command.room === room) resolve(command)
      })
    })

    gateway.emitToUser(fx.users.member.id, 'test.ping', { run })

    expect(await received).toEqual({ kind: 'emit', room, event: 'test.ping', payload: { run } })
    listener.disconnect()
  })
})

describe('узел api', () => {
  beforeAll(() => {
    gateway.startRealtime(fx.app, {
      resolveSession: (token) => AuthService.resolveSession(token),
      accessAttributesOf: (session) => AuthService.accessAttributesOf(session),
    })
  })

  it('доставляет команду из канала сокетам пользователя', async () => {
    const socket = await connect(fx.users.member)
    const got = next<{ run: string }>(socket, 'test.ping')

    await gateway.publishRelay({
      kind: 'emit',
      room: `user:${fx.users.member.id}`,
      event: 'test.ping',
      payload: { run },
    })

    expect(await got).toEqual({ run })
  })

  it('при отзыве прав исключает сокет из комнаты объекта', async () => {
    const folder = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: `Папка ретрансляции ${run}`, spaceId: fx.spaceId },
    })
    expect(folder.statusCode, folder.body).toBe(200)
    const folderId = folder.json().id as string
    const room = `object:${folderId}`

    const socket = await connect(fx.users.member)
    const ack = (await socket.emitWithAck('subscribe', { rooms: [room] })) as {
      granted: string[]
    }
    expect(ack.granted).toEqual([room])

    // Разрыв наследования копирует права явно — снимаем запись участника,
    // после этого папку он больше не видит
    const mode = await call(fx.app, {
      method: 'PUT',
      url: `/objects/${folderId}/access-mode`,
      as: fx.admin,
      payload: { mode: 'restricted' },
    })
    expect(mode.statusCode, mode.body).toBe(200)
    const removed = await call(fx.app, {
      method: 'DELETE',
      url: `/objects/${folderId}/access`,
      as: fx.admin,
      payload: { principal: { type: 'user', id: fx.users.member.id } },
    })
    expect(removed.statusCode, removed.body).toBe(200)
    const hidden = await call(fx.app, { url: `/objects/${folderId}`, as: fx.users.member })
    expect(hidden.statusCode).toBe(404)

    const revoked = next<{ objectId: string }>(socket, 'acl.revoked')
    await gateway.revokeRoomAccess(folderId)
    expect(await revoked).toEqual({ objectId: folderId })

    // Сообщения комнаты объекта больше не доходят
    const silence = next(socket, 'object.updated', 500).then(
      () => 'получено',
      () => 'тишина',
    )
    gateway.emitToRoom(room, 'object.updated', { id: folderId })
    expect(await silence).toBe('тишина')
  })
})
