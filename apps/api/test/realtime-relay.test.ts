import { randomUUID } from 'node:crypto'
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
 * api на случайном порту. Каналы pub/sub Redis общие для всех баз — свои сообщения
 * тесты узнают по уникальным идентификаторам.
 */
registerLifecycle()

const gateway = await import('../src/kernel/realtime/gateway.js')
const { publishJobSignal } = await import('../src/kernel/jobs/signal.js')
const { AuthService } = await import('../src/modules/identity/public.js')
const { createRedisConnection, redis } = await import('../src/shared/redis/index.js')

let fx: TestContext
let base: string
let sequence = Date.now()
const opened: Socket[] = []

/** Идентификатор уведомления, которого нет ни у одного другого процесса стенда. */
const uniqueNotificationId = () => String(++sequence)

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

/** Первое событие сокета, подошедшее под условие; без него за отведённое время — ошибка. */
function next<T>(
  socket: Socket,
  event: string,
  matches: (payload: T) => boolean = () => true,
  timeoutMs = 5_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const listener = (payload: T) => {
      if (!matches(payload)) return
      clearTimeout(timer)
      socket.off(event, listener)
      resolve(payload)
    }
    const timer = setTimeout(() => {
      socket.off(event, listener)
      reject(new Error(`нет события ${event}`))
    }, timeoutMs)
    socket.on(event, listener)
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
    const id = uniqueNotificationId()
    // В канал пишут и другие процессы стенда — ждём своё сообщение
    const received = new Promise<unknown>((resolve) => {
      listener.on('message', (_channel, message) => {
        const command = JSON.parse(message) as { room?: string; payload?: { id?: string } }
        if (command.room === room && command.payload?.id === id) resolve(command)
      })
    })

    gateway.emitToUser(fx.users.member.id, 'notification.new', { id, aggregated: false })

    expect(await received).toEqual({
      kind: 'emit',
      room,
      event: 'notification.new',
      payload: { id, aggregated: false },
    })
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
    const id = uniqueNotificationId()
    const got = next<{ id: string }>(socket, 'notification.new', (payload) => payload.id === id)

    await gateway.publishRelay({
      kind: 'emit',
      room: `user:${fx.users.member.id}`,
      event: 'notification.new',
      payload: { id, aggregated: false },
    })

    expect(await got).toEqual({ id, aggregated: false })
  })

  it('событие вне протокола (ADR-0192) из канала не доставляет', async () => {
    const socket = await connect(fx.users.member)
    const seen: string[] = []
    socket.onAny((event: string) => seen.push(event))
    const room = `user:${fx.users.member.id}`
    const id = uniqueNotificationId()
    const got = next<{ id: string }>(socket, 'notification.new', (payload) => payload.id === id)

    // Минуя типы `emitToRoom`: так в канал мог бы написать процесс другой версии
    await redis().publish(
      gateway.RELAY_CHANNEL,
      JSON.stringify({ kind: 'emit', room, event: 'test.ping', payload: { id } }),
    )
    await gateway.publishRelay({
      kind: 'emit',
      room,
      event: 'notification.new',
      payload: { id, aggregated: false },
    })

    // Команды канала узел выполняет по порядку: когда дошла верная, неверная уже отброшена
    await got
    expect(seen).not.toContain('test.ping')
  })

  it('ход и исход задания доходят до инициатора без подписки на комнату задания', async () => {
    const socket = await connect(fx.users.member)
    const jobId = randomUUID()
    const progress = next(socket, 'job.progress', (p: { jobId: string }) => p.jobId === jobId)

    await publishJobSignal({
      jobId,
      initiatorId: fx.users.member.id,
      progress: 0.5,
      message: 'половина',
    })
    // Инициатор в сообщении клиенту не нужен
    expect(await progress).toEqual({ jobId, progress: 0.5, message: 'половина' })

    const finished = next(socket, 'job.finished', (p: { jobId: string }) => p.jobId === jobId)
    await publishJobSignal({ jobId, initiatorId: fx.users.member.id, status: 'succeeded' })
    expect(await finished).toEqual({ jobId, status: 'succeeded' })
  })

  it('подписку не по протоколу отклоняет целиком', async () => {
    const socket = await connect(fx.users.member)
    const ack = await socket.emitWithAck('subscribe', { rooms: ['object:не-идентификатор'] })
    expect(ack).toEqual({ granted: [], denied: [] })
    const empty = await socket.emitWithAck('subscribe', { rooms: 'object:всё' })
    expect(empty).toEqual({ granted: [], denied: [] })
  })

  it('при отзыве прав исключает сокет из комнаты объекта', async () => {
    const folder = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: `Папка ретрансляции ${sequence}`, spaceId: fx.spaceId },
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
    const silence = next(socket, 'object.updated', () => true, 500).then(
      () => 'получено',
      () => 'тишина',
    )
    gateway.emitToRoom(room, 'object.updated', {
      id: folderId,
      type: 'folder',
      version: 0,
      changedFields: null,
      actorId: null,
    })
    expect(await silence).toBe('тишина')
  })

  it('исключение из группы закрывает комнату объекта, открытого группе (ADR-0177)', async () => {
    // Посторонний видит закрытую папку только как участник группы
    const group = await call(fx.app, {
      method: 'POST',
      url: '/groups',
      as: fx.admin,
      payload: { name: `Группа комнат ${sequence}` },
    })
    expect(group.statusCode, group.body).toBe(200)
    const groupId = group.json().id as string
    const members = (userIds: string[]) =>
      call(fx.app, {
        method: 'PUT',
        url: `/groups/${groupId}/members`,
        as: fx.admin,
        payload: { userIds },
      })
    expect((await members([fx.users.stranger.id])).statusCode).toBe(200)

    const folder = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: `Папка группы ${sequence}`, spaceId: fx.spaceId },
    })
    const folderId = folder.json().id as string
    const room = `object:${folderId}`
    const restricted = await call(fx.app, {
      method: 'PUT',
      url: `/objects/${folderId}/access-mode`,
      as: fx.admin,
      payload: { mode: 'restricted' },
    })
    expect(restricted.statusCode, restricted.body).toBe(200)
    const granted = await call(fx.app, {
      method: 'POST',
      url: `/objects/${folderId}/access`,
      as: fx.admin,
      payload: { grants: [{ principal: { type: 'group', id: groupId }, level: 'view' }] },
    })
    expect(granted.statusCode, granted.body).toBe(200)

    const socket = await connect(fx.users.stranger)
    const ack = (await socket.emitWithAck('subscribe', { rooms: [room] })) as {
      granted: string[]
    }
    expect(ack.granted).toEqual([room])

    // Состав группы меняется — сокет, открытый до этого, теряет комнату сам
    const revoked = next<{ objectId: string }>(socket, 'acl.revoked')
    expect((await members([])).statusCode).toBe(200)
    expect(await revoked).toEqual({ objectId: folderId })
  })
})
