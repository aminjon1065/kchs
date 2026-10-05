import {
  type AdminModeState,
  type Confidentiality,
  RT_SERVER_EVENTS,
  type RtClientEvent,
  RtPresenceTarget,
  type RtServerEvent,
  type RtServerEvents,
  type RtServerPayload,
  RtTypingSignal,
  type SubscribeAck,
  SubscribeInput,
} from '@kchs/contracts'
import { createAdapter } from '@socket.io/redis-adapter'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { type DefaultEventsMap, Server as SocketServer } from 'socket.io'
import { z } from 'zod'
import { config } from '~/shared/config/index.js'
import type { UserCtx } from '~/shared/context.js'
import { logger } from '~/shared/logger/index.js'
import { createRedisConnection, redis } from '~/shared/redis/index.js'
import { authorize } from '../access/authorize.js'
import { getPrincipalSet } from '../access/principal-set.js'
import { buildUserCtx } from '../context-builder.js'
import { JobService } from '../jobs/service.js'
import { JOB_SIGNAL_CHANNEL, JobSignal } from '../jobs/signal.js'
import { canSeeJob } from '../jobs/visibility.js'
import { markLeft, markViewing, type Viewer } from './presence.js'

interface SocketData {
  ctx: UserCtx
}

/**
 * Что шлёт клиент (протокол — ADR-0192). До разбора схемой контракта нагрузка — `unknown`:
 * браузеру шлюз не доверяет.
 */
type ClientMessages = {
  [E in RtClientEvent]: (payload: unknown, ack?: (result: SubscribeAck) => void) => void
}

type Gateway = SocketServer<ClientMessages, RtServerEvents, DefaultEventsMap, SocketData>

let io: Gateway | null = null
/** Подписки шлюза на каналы Redis — закрываются вместе с ним. */
let channels: Redis[] = []

/**
 * Канал ретрансляции (01-overview.md §Realtime). Подписчики событий работают в
 * worker, а сокеты открыты на узлах api: процесс без шлюза кладёт команду в
 * канал, каждый узел api выполняет её над своими сокетами. Так отправка не
 * задваивается при нескольких репликах api, а права перепроверяются по
 * настоящему контексту сокета, а не по его копии через адаптер.
 */
export const RELAY_CHANNEL = 'rt:relay'

/**
 * Команда ретрансляции. Событие — только из протокола: нагрузку проверил тип `emitToRoom`
 * в процессе-отправителе, а имя вне протокола узел api не доставляет.
 */
const RelayCommand = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('emit'),
    room: z.string(),
    event: z.enum(RT_SERVER_EVENTS),
    payload: z.unknown(),
  }),
  z.object({ kind: z.literal('revoke'), objectId: z.string() }),
  z.object({ kind: z.literal('recheck'), userId: z.string() }),
])
export type RelayCommand = z.infer<typeof RelayCommand>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Разрешение сессии приходит извне: ядро не знает о модуле идентификации
 * (01-overview.md §Правила границ).
 */
export interface RealtimeDeps {
  resolveSession: (token: string) => Promise<{
    sessionId: string
    userId: string
    onBehalfOf: string | null
    mfaEnrolled: boolean
  } | null>
  /**
   * Допуск и режим администратора (ADR-0080): контекст сокета — снимок на
   * момент подключения, поэтому они перечитываются при подписке на комнаты и
   * при их смене (выход из режима, новый допуск).
   */
  accessAttributesOf?: (session: {
    sessionId: string
    userId: string
  }) => Promise<{ clearance: Confidentiality; adminMode: AdminModeState | null }>
}

let realtimeDeps: RealtimeDeps | null = null

/** Контекст сокета с актуальными допуском и режимом администратора. */
async function withFreshAccess(ctx: UserCtx): Promise<UserCtx> {
  // Принципалы — тоже свежие (ADR-0177): исключённый из группы или пространства
  // иначе сохранил бы комнаты по снимку на момент подключения
  const principals = await getPrincipalSet(ctx.userId)
  if (!realtimeDeps?.accessAttributesOf) return { ...ctx, principals }
  const fresh = await realtimeDeps.accessAttributesOf({
    sessionId: ctx.sessionId,
    userId: ctx.userId,
  })
  return {
    ...ctx,
    principals,
    clearance: fresh.clearance,
    adminMode: ctx.isSystemAdmin ? fresh.adminMode : null,
  }
}

class SocketRefused extends Error {
  constructor(readonly reason: 'unauthorized' | 'setup_required') {
    super(reason)
  }
}

/**
 * Проверка подключения к шлюзу: сессия из cookie и завершённая настройка входа.
 * Пока не сменён временный пароль или не подключён обязательный второй фактор,
 * пользователю доступен только профиль — событий объектов он тоже не получает.
 */
export async function authenticateSocket(
  cookieHeader: string,
  meta: { id: string; ip: string; headers: Record<string, unknown> },
  deps: RealtimeDeps,
): Promise<UserCtx> {
  const token = parseCookies(cookieHeader)[config().SESSION_COOKIE_NAME]
  if (!token) throw new SocketRefused('unauthorized')
  const session = await deps.resolveSession(token)
  if (!session) throw new SocketRefused('unauthorized')
  const ctx = await buildUserCtx(session, meta as never)
  if (ctx.mustChangePassword || ctx.mfaEnrollmentRequired) throw new SocketRefused('setup_required')
  return ctx
}

/**
 * WebSocket-шлюз (16-api-and-events.md §3).
 * Комнаты: user:{id}, space:{id}, object:{id}, conversation:{id}, job:{id}.
 * Вход в комнату объекта проверяется `authorize(view)`.
 */
export function startRealtime(app: FastifyInstance, deps: RealtimeDeps): SocketServer {
  const env = config()
  const log = logger().child({ module: 'realtime' })
  realtimeDeps = deps

  io = new SocketServer<ClientMessages, RtServerEvents, DefaultEventsMap, SocketData>(app.server, {
    path: '/ws',
    cors: { origin: [env.KCHS_BASE_URL], credentials: true },
    serveClient: false,
    transports: ['websocket', 'polling'],
    pingInterval: 20_000,
    pingTimeout: 20_000,
  })

  io.adapter(createAdapter(createRedisConnection('io-pub'), createRedisConnection('io-sub')))

  io.use(async (socket, next) => {
    try {
      socket.data.ctx = await authenticateSocket(
        socket.handshake.headers.cookie ?? '',
        { id: socket.id, ip: socket.handshake.address, headers: socket.handshake.headers },
        deps,
      )
      next()
    } catch (error) {
      log.warn({ err: error }, 'отклонено подключение realtime')
      next(new Error(error instanceof SocketRefused ? error.reason : 'unauthorized'))
    }
  })

  io.on('connection', (socket) => {
    const ctx = socket.data.ctx
    // Объекты, где сокет отметил присутствие: при отключении убираем только их
    const viewed = new Set<string>()
    void socket.join(`user:${ctx.userId}`)
    for (const spaceId of Object.keys(ctx.principals.spaceRoles)) {
      void socket.join(`space:${spaceId}`)
    }

    socket.on('subscribe', async (payload, ack) => {
      const input = SubscribeInput.safeParse(payload)
      if (!input.success) {
        ack?.({ granted: [], denied: [] })
        return
      }
      const granted: string[] = []
      const denied: string[] = []
      const current = await withFreshAccess(socket.data.ctx)
      socket.data.ctx = current
      for (const room of input.data.rooms) {
        if (await canJoin(current, room)) {
          await socket.join(room)
          granted.push(room)
        } else {
          denied.push(room)
        }
      }
      ack?.({ granted, denied })
    })

    socket.on('unsubscribe', (payload) => {
      const input = SubscribeInput.safeParse(payload)
      if (!input.success) return
      for (const room of input.data.rooms) void socket.leave(room)
    })

    socket.on('presence.view', async (payload) => {
      const input = RtPresenceTarget.safeParse(payload)
      if (!input.success) return
      const { objectId } = input.data
      const room = `object:${objectId}`
      if (!(await canJoin(socket.data.ctx, room))) return
      // Смотрящий — в комнате до рассылки: подписка на комнаты вкладок обрабатывается
      // параллельно и может закончиться позже, тогда он не узнал бы, кто уже смотрит
      await socket.join(room)
      viewed.add(objectId)
      const users = await markViewing(objectId, {
        id: ctx.userId,
        displayName: ctx.displayName,
      })
      broadcastPresence(objectId, users)
    })

    // Вкладка закрыта или ушла из вида — соседи видят это сразу, а не через минуту
    socket.on('presence.leave', async (payload) => {
      const input = RtPresenceTarget.safeParse(payload)
      if (!input.success || !viewed.has(input.data.objectId)) return
      const { objectId } = input.data
      viewed.delete(objectId)
      broadcastPresence(objectId, await markLeft(objectId, ctx.userId))
    })

    socket.on('typing', (payload) => {
      const input = RtTypingSignal.safeParse(payload)
      if (!input.success) return
      const { conversationId } = input.data
      // Писать в комнату может только тот, кого в неё впустили после проверки прав
      const room = `conversation:${conversationId}`
      if (!socket.rooms.has(room)) return
      socket.to(room).emit('typing', {
        conversationId,
        userId: ctx.userId,
        displayName: ctx.displayName,
      })
    })

    socket.on('disconnect', () => {
      void cleanupPresence(ctx.userId, viewed)
    })
  })

  // Ход заданий из воркеров приходит через Redis pub/sub. Сообщение получает каждый
  // узел api, поэтому каждый отправляет его только своим сокетам
  const jobs = createRedisConnection('rt-job-sub')
  void jobs.subscribe(JOB_SIGNAL_CHANNEL)
  jobs.on('message', (_channel, message) => deliverJobSignal(message))

  const relay = createRedisConnection('rt-relay-sub')
  void relay.subscribe(RELAY_CHANNEL)
  relay.on('message', (_channel, message) => {
    handleRelay(message).catch((error) =>
      log.warn({ err: error }, 'команда ретрансляции realtime не выполнена'),
    )
  })
  channels = [jobs, relay]

  log.info('realtime-шлюз запущен')
  return io
}

function parseJson(message: string): unknown {
  try {
    return JSON.parse(message)
  } catch {
    return null
  }
}

/**
 * Ход задания — в комнату задания (её открыл экран задания) и в комнату инициатора:
 * строка состояния его вкладок показывает «Мои задания» без подписки на каждое.
 */
function deliverJobSignal(message: string): void {
  const signal = JobSignal.safeParse(parseJson(message))
  if (!io || !signal.success) return
  const { jobId, initiatorId } = signal.data
  const target = io.local.to(initiatorId ? [`job:${jobId}`, `user:${initiatorId}`] : `job:${jobId}`)
  if ('status' in signal.data) {
    target.emit('job.finished', { jobId, status: signal.data.status })
  } else {
    target.emit('job.progress', {
      jobId,
      progress: signal.data.progress,
      message: signal.data.message,
    })
  }
}

/** Команда ретрансляции на этом узле api — только над его собственными сокетами. */
async function handleRelay(message: string): Promise<void> {
  if (!io) return
  const command = RelayCommand.safeParse(parseJson(message))
  if (!command.success) {
    logger().warn({ issues: command.error.issues }, 'команда ретрансляции realtime не по протоколу')
    return
  }
  switch (command.data.kind) {
    case 'emit':
      emitLocal(command.data.room, command.data.event, command.data.payload)
      return
    case 'revoke':
      return revokeLocal(command.data.objectId)
    case 'recheck':
      return recheckLocal(command.data.userId)
  }
}

/**
 * Команда всем узлам api через Redis — так её выполняют там, где открыты сокеты.
 * Экспортирована для тестов ретрансляции.
 */
export async function publishRelay(command: RelayCommand): Promise<void> {
  try {
    await redis().publish(RELAY_CHANNEL, JSON.stringify(command))
  } catch (error) {
    logger().warn({ err: error, kind: command.kind }, 'команда realtime не передана узлам api')
  }
}

/** Проверка входа в комнату (16-api-and-events.md §3); экспортирована для тестов доступа. */
export async function canJoin(ctx: UserCtx, room: string): Promise<boolean> {
  const [kind, id] = room.split(':')
  if (!kind || !id) return false
  // Идентификаторы комнат — UUID; остальное отклоняем до обращения к базе
  if (kind !== 'user' && !UUID_RE.test(id)) return false
  switch (kind) {
    case 'user':
      return id === ctx.userId
    case 'space':
      return Boolean(ctx.principals.spaceRoles[id]) || ctx.isSystemAdmin
    case 'object':
    case 'conversation': {
      const decision = await authorize(ctx, 'view', id, { soft: true })
      return decision.allowed
    }
    case 'job': {
      // Прогресс задания — тем, кто видит само задание (ADR-0172)
      const job = await JobService.get(id).catch(() => null)
      return Boolean(job && (await canSeeJob(ctx, job)))
    }
    default:
      return false
  }
}

async function cleanupPresence(userId: string, objectIds: Set<string>): Promise<void> {
  for (const objectId of objectIds) broadcastPresence(objectId, await markLeft(objectId, userId))
}

function broadcastPresence(objectId: string, users: Viewer[]): void {
  io?.to(`object:${objectId}`).emit('presence', { objectId, users })
}

/**
 * Отправка сообщения в комнату — только события протокола с их нагрузкой (ADR-0192). На узле
 * api — напрямую: адаптер Redis доставит её и на другие узлы. В процессе без шлюза (worker,
 * где работают подписчики событий) — через канал ретрансляции.
 */
export function emitToRoom<E extends RtServerEvent>(
  room: string,
  event: E,
  payload: RtServerPayload<E>,
): void {
  if (io) {
    emitVia(io.to(room), event, payload)
    return
  }
  void publishRelay({ kind: 'emit', room, event, payload })
}

export function emitToUser<E extends RtServerEvent>(
  userId: string,
  event: E,
  payload: RtServerPayload<E>,
): void {
  emitToRoom(`user:${userId}`, event, payload)
}

/** Ретранслированное событие — только сокетам этого узла: другие узлы получили его сами. */
function emitLocal(room: string, event: RtServerEvent, payload: unknown): void {
  if (io) emitVia(io.local.to(room), event, payload)
}

/**
 * Типизированный `emit` Socket.IO не сводит обобщённое имя события к его нагрузке: здесь
 * пара уже проверена сигнатурой `emitToRoom` или схемой команды ретрансляции.
 */
function emitVia(
  target: { emit: (event: RtServerEvent, payload: never) => boolean },
  event: RtServerEvent,
  payload: unknown,
): void {
  target.emit(event, payload as never)
}

/**
 * Исключение пользователей из комнаты объекта при отзыве прав. Сокеты открыты на
 * узлах api, поэтому перепроверку выполняет каждый узел над своими сокетами.
 */
export async function revokeRoomAccess(objectId: string): Promise<void> {
  await publishRelay({ kind: 'revoke', objectId })
}

async function revokeLocal(objectId: string): Promise<void> {
  if (!io) return
  const room = `object:${objectId}`
  for (const socket of await io.local.in(room).fetchSockets()) {
    const ctx = socket.data.ctx
    const decision = await authorize(ctx, 'view', objectId, { soft: true })
    if (!decision.allowed) {
      socket.emit('acl.revoked', { objectId })
      await socket.leave(room)
    }
  }
}

/**
 * Перепроверка комнат объектов пользователя: режим администратора выключен,
 * допуск понижен (ADR-0080) — комнаты объектов с грифом выше допуска закрываются.
 * Как и отзыв, выполняется каждым узлом api над своими сокетами.
 */
export async function recheckUserRooms(userId: string): Promise<void> {
  await publishRelay({ kind: 'recheck', userId })
}

async function recheckLocal(userId: string): Promise<void> {
  if (!io) return
  for (const socket of await io.local.in(`user:${userId}`).fetchSockets()) {
    const ctx = await withFreshAccess(socket.data.ctx)
    socket.data.ctx = ctx
    for (const room of socket.rooms) {
      if (!room.startsWith('object:') && !room.startsWith('conversation:')) continue
      if (await canJoin(ctx, room)) continue
      socket.emit('acl.revoked', { objectId: room.slice(room.indexOf(':') + 1) })
      socket.leave(room)
    }
  }
}

/** Открытые подключения этого процесса (метрика, 15-admin-operations.md §4). */
export function realtimeConnections(): number {
  return io?.engine.clientsCount ?? 0
}

export function stopRealtime(): void {
  void io?.close()
  io = null
  realtimeDeps = null
  for (const connection of channels) connection.disconnect()
  channels = []
}

function parseCookies(header: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    result[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
  }
  return result
}
