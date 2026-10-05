import {
  type JobRecord,
  ROOMS_PER_SUBSCRIBE,
  type RtClientEvents,
  type RtServerEvent,
  type RtServerEvents,
  type RtServerPayload,
} from '@kchs/contracts'
import type { QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { io, type Socket } from 'socket.io-client'
import { keyMentions } from './query-match.js'

export type RealtimeStatus = 'connecting' | 'connected' | 'disconnected'

/**
 * Сокет шлюза — только здесь: события сервера слушает этот модуль и обработчики
 * `onRealtimeEvent`, отправляют — его функции. Имена и нагрузки — протокол из контрактов
 * (ADR-0192), тест протокола сверяет с ним подписки и отправки.
 */
let socket: Socket<RtServerEvents, RtClientEvents> | null = null
let status: RealtimeStatus = 'disconnected'
const listeners = new Set<() => void>()

/** Кто смотрит объект — по сообщениям `presence` из комнаты `object:{id}`. */
export type PresenceUser = RtServerPayload<'presence'>['users'][number]
const NOBODY: PresenceUser[] = []
const presence = new Map<string, PresenceUser[]>()
const presenceListeners = new Set<() => void>()

/**
 * Комнаты, которые держат экраны, со счётчиком: одну комнату могут держать несколько
 * экранов. Шлюз забывает комнаты сокета при переподключении — после него подписка
 * повторяется для всех.
 */
const wanted = new Map<string, number>()
/** Комнаты, отпущенные в этом такте: отписка уйдёт, если их тут же не взяли снова. */
const released = new Set<string>()

function setStatus(next: RealtimeStatus): void {
  if (status === next) return
  status = next
  for (const listener of listeners) listener()
}

export interface RealtimeHandlers {
  onInboxChanged?: (payload: RtServerPayload<'inbox.changed'>) => void
  onAclRevoked?: (payload: RtServerPayload<'acl.revoked'>) => void
}

/**
 * Клиент realtime (16-api-and-events.md §3). Уведомление не крадёт фокус:
 * обновления инвалидируют кэш, а UI обновляется мягко.
 */
export function connectRealtime(client: QueryClient, handlers: RealtimeHandlers = {}): void {
  if (socket?.connected) return

  setStatus('connecting')
  socket = io({
    path: '/ws',
    withCredentials: true,
    transports: ['websocket', 'polling'],
    reconnectionDelay: 500,
    reconnectionDelayMax: 8000,
  })

  socket.on('connect', () => {
    setStatus('connected')
    // Новое подключение — новый сокет на сервере: комнаты экранов берутся заново
    sendRooms('subscribe', [...wanted.keys()])
  })
  socket.on('disconnect', () => setStatus('disconnected'))
  socket.on('connect_error', () => setStatus('disconnected'))

  // Сообщения модулей (входящий звонок, комната встречи): шлюз общий, а
  // обработчики живут в своих функциях и подписываются, когда им нужно
  socket.onAny((event: string, payload: unknown) => {
    for (const handler of moduleHandlers.get(event as RtServerEvent) ?? []) handler(payload)
  })

  socket.on('object.updated', (payload) => {
    // Все запросы объекта, а не только карточка: у модулей свои ключи —
    // `['dataset', id]`, `['map', id]`, `['meeting', id]`…
    void client.invalidateQueries({
      predicate: (query) => keyMentions(query.queryKey, payload.id),
    })
    void client.invalidateQueries({ queryKey: ['objects'] })
  })

  socket.on('object.removed', () => {
    void client.invalidateQueries({ queryKey: ['objects'] })
  })

  socket.on('message.posted', (payload) => {
    void client.invalidateQueries({ queryKey: ['object', payload.objectId] })
    // Непрочитанное и последнее сообщение в списке бесед (ADR-0090)
    void client.invalidateQueries({ queryKey: ['chats'] })
  })

  // Правка, удаление, реакция — перечитать обсуждение объекта
  socket.on('message.updated', (payload) => {
    void client.invalidateQueries({ queryKey: ['object', payload.objectId] })
  })

  // Запись ленты активности появилась — перечитать ленту открытого объекта
  socket.on('activity.added', (payload) => {
    void client.invalidateQueries({ queryKey: ['object', payload.objectId, 'activity'] })
  })

  socket.on('notification.new', () => {
    void client.invalidateQueries({ queryKey: ['notifications'] })
  })

  // Новое сообщение, состав беседы, переименование — список бесед и счётчики (ADR-0090)
  socket.on('chat.changed', () => {
    void client.invalidateQueries({ queryKey: ['chats'] })
  })

  // Свой статус «на встрече»: вошёл в комнату или вышел — на этой вкладке или на другой
  socket.on('presence.changed', () => {
    void client.invalidateQueries({ queryKey: ['chats', 'presence'], exact: true })
  })

  // Приглашение, ответ участника, перенос встречи — сетка и «Сегодня» (ADR-0081)
  socket.on('calendar.changed', () => {
    void client.invalidateQueries({ queryKey: ['calendar'] })
  })

  socket.on('inbox.changed', (payload) => {
    void client.invalidateQueries({ queryKey: ['inbox'] })
    handlers.onInboxChanged?.(payload)
  })

  // Ход задания правит «Мои задания» в кэше на месте — без запроса на каждое сообщение;
  // задания, которого в списке ещё нет, — перечитать список, не чаще раза в секунду
  let jobsRefresh: ReturnType<typeof setTimeout> | undefined
  const refreshJobs = (): void => {
    if (jobsRefresh !== undefined) return
    jobsRefresh = setTimeout(() => {
      jobsRefresh = undefined
      void client.invalidateQueries({ queryKey: ['jobs'] })
    }, 1_000)
  }
  socket.on('job.progress', (payload) => {
    let known = false
    client.setQueryData<{ items: JobRecord[] }>(['jobs'], (current) => {
      if (!current) return current
      const items = current.items.map((job) => {
        if (job.id !== payload.jobId) return job
        known = true
        return { ...job, progress: payload.progress, message: payload.message }
      })
      return known ? { items } : current
    })
    if (!known) refreshJobs()
  })

  socket.on('job.finished', () => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
  })

  socket.on('acl.revoked', (payload) => {
    handlers.onAclRevoked?.(payload)
  })

  socket.on('presence', (payload) => {
    presence.set(payload.objectId, payload.users)
    for (const listener of presenceListeners) listener()
  })
}

type ModuleHandler = (payload: unknown) => void
const moduleHandlers = new Map<RtServerEvent, Set<ModuleHandler>>()

/**
 * Подписка модуля на сообщение шлюза (входящий звонок, состав комнаты):
 * переживает переподключение, снимается возвращённой функцией.
 */
export function onRealtimeEvent<E extends RtServerEvent>(
  event: E,
  handler: (payload: RtServerPayload<E>) => void,
): () => void {
  // Нагрузку `onAny` отдаёт без типа; имя события здесь задаёт её тип
  const listener = handler as ModuleHandler
  const set = moduleHandlers.get(event) ?? new Set<ModuleHandler>()
  set.add(listener)
  moduleHandlers.set(event, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) moduleHandlers.delete(event)
  }
}

/** Подписка и отписка — пачками: больше `ROOMS_PER_SUBSCRIBE` шлюз в одном сообщении не примет. */
function sendRooms(kind: 'subscribe' | 'unsubscribe', rooms: string[]): void {
  if (!socket?.connected) return
  for (let start = 0; start < rooms.length; start += ROOMS_PER_SUBSCRIBE) {
    const batch = { rooms: rooms.slice(start, start + ROOMS_PER_SUBSCRIBE) }
    if (kind === 'subscribe') socket.emit('subscribe', batch)
    else socket.emit('unsubscribe', batch)
  }
}

/**
 * Экран держит комнаты, пока они ему нужны. До подключения и после переподключения
 * подписку отправляет обработчик `connect`.
 */
export function subscribeRooms(rooms: string[]): void {
  const fresh: string[] = []
  for (const room of rooms) {
    const count = wanted.get(room) ?? 0
    wanted.set(room, count + 1)
    // Отпущенная в этом такте комната на сервере ещё есть — подписываться не нужно
    if (count === 0 && !released.delete(room)) fresh.push(room)
  }
  sendRooms('subscribe', fresh)
}

export function unsubscribeRooms(rooms: string[]): void {
  for (const room of rooms) {
    const count = (wanted.get(room) ?? 0) - 1
    if (count > 0) {
      wanted.set(room, count)
      continue
    }
    wanted.delete(room)
    released.add(room)
  }
  // Отписка — после текущего такта: эффект, сменивший набор комнат (открыли ещё вкладку),
  // сначала отпускает прежние и сразу берёт новые — общие комнаты остаются без разрыва
  queueMicrotask(flushReleased)
}

function flushReleased(): void {
  if (released.size === 0) return
  const rooms = [...released]
  released.clear()
  sendRooms('unsubscribe', rooms)
}

/**
 * «Печатает» в беседе: шлюз пересылает соседям по её комнате, в базу ничего
 * не пишется (ADR-0161). Вызывающий сам не шлёт чаще раза в несколько секунд.
 */
export function emitTyping(conversationId: string): void {
  socket?.emit('typing', { conversationId })
}

/** Отметка просмотра видимой вкладки (раз в 30 с) или уход с неё. */
export function reportPresence(objectId: string, state: 'view' | 'leave'): void {
  if (state === 'view') socket?.emit('presence.view', { objectId })
  else socket?.emit('presence.leave', { objectId })
}

export function usePresence(objectId: string): PresenceUser[] {
  return useSyncExternalStore(
    (listener) => {
      presenceListeners.add(listener)
      return () => presenceListeners.delete(listener)
    },
    () => presence.get(objectId) ?? NOBODY,
    () => NOBODY,
  )
}

export function disconnectRealtime(): void {
  socket?.disconnect()
  socket = null
  presence.clear()
  wanted.clear()
  released.clear()
  setStatus('disconnected')
}

export function useRealtimeStatus(): RealtimeStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => status,
    () => 'disconnected' as const,
  )
}
