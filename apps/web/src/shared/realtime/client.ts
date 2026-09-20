import type { QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { io, type Socket } from 'socket.io-client'

export type RealtimeStatus = 'connecting' | 'connected' | 'disconnected'

let socket: Socket | null = null
let status: RealtimeStatus = 'disconnected'
const listeners = new Set<() => void>()

/** Кто смотрит объект — по сообщениям `presence` из комнаты `object:{id}`. */
export interface PresenceUser {
  id: string
  displayName: string
  avatarUrl: string | null
}
const NOBODY: PresenceUser[] = []
const presence = new Map<string, PresenceUser[]>()
const presenceListeners = new Set<() => void>()

function setStatus(next: RealtimeStatus): void {
  if (status === next) return
  status = next
  for (const listener of listeners) listener()
}

export interface RealtimeHandlers {
  onObjectUpdated?: (payload: { id: string; type: string; changedFields: string[] | null }) => void
  onObjectRemoved?: (payload: { id: string }) => void
  onMessagePosted?: (payload: { conversationId: string; messageId: string }) => void
  onNotification?: () => void
  onInboxChanged?: (payload: { counts: { total: number; overdue: number } }) => void
  onJobProgress?: (payload: { jobId: string; progress: number; message: string | null }) => void
  onAclRevoked?: (payload: { objectId: string }) => void
}

/**
 * Клиент realtime (16-api-and-events.md §3). Уведомление не крадёт фокус:
 * обновления инвалидируют кэш, а UI обновляется мягко.
 */
export function connectRealtime(client: QueryClient, handlers: RealtimeHandlers = {}): Socket {
  if (socket?.connected) return socket

  setStatus('connecting')
  socket = io({
    path: '/ws',
    withCredentials: true,
    transports: ['websocket', 'polling'],
    reconnectionDelay: 500,
    reconnectionDelayMax: 8000,
  })

  socket.on('connect', () => setStatus('connected'))
  socket.on('disconnect', () => setStatus('disconnected'))
  socket.on('connect_error', () => setStatus('disconnected'))

  // Сообщения модулей (входящий звонок, комната встречи): шлюз общий, а
  // обработчики живут в своих функциях и подписываются, когда им нужно
  socket.onAny((event: string, payload: unknown) => {
    for (const handler of moduleHandlers.get(event) ?? []) handler(payload)
  })

  socket.on(
    'object.updated',
    (payload: { id: string; type: string; changedFields: string[] | null }) => {
      void client.invalidateQueries({ queryKey: ['object', payload.id] })
      void client.invalidateQueries({ queryKey: ['objects'] })
      handlers.onObjectUpdated?.(payload)
    },
  )

  socket.on('object.removed', (payload: { id: string }) => {
    void client.invalidateQueries({ queryKey: ['objects'] })
    handlers.onObjectRemoved?.(payload)
  })

  socket.on(
    'message.posted',
    (payload: { conversationId: string; messageId: string; objectId?: string }) => {
      if (payload.objectId) {
        void client.invalidateQueries({ queryKey: ['object', payload.objectId] })
      } else {
        void client.invalidateQueries({ queryKey: ['object'] })
      }
      // Непрочитанное и последнее сообщение в списке бесед (ADR-0090)
      void client.invalidateQueries({ queryKey: ['chats'] })
      handlers.onMessagePosted?.(payload)
    },
  )

  // Правка, удаление, реакция — перечитать обсуждение объекта
  socket.on('message.updated', (payload: { objectId?: string }) => {
    if (payload.objectId) void client.invalidateQueries({ queryKey: ['object', payload.objectId] })
  })

  socket.on('notification.new', () => {
    void client.invalidateQueries({ queryKey: ['notifications'] })
    handlers.onNotification?.()
  })

  // Новое сообщение, состав беседы, переименование — список бесед и счётчики (ADR-0090)
  socket.on('chat.changed', () => {
    void client.invalidateQueries({ queryKey: ['chats'] })
  })

  // Приглашение, ответ участника, перенос встречи — сетка и «Сегодня» (ADR-0081)
  socket.on('calendar.changed', () => {
    void client.invalidateQueries({ queryKey: ['calendar'] })
  })

  socket.on('inbox.changed', (payload: { counts: { total: number; overdue: number } }) => {
    void client.invalidateQueries({ queryKey: ['inbox'] })
    handlers.onInboxChanged?.(payload)
  })

  socket.on(
    'job.progress',
    (payload: { jobId: string; progress: number; message: string | null }) => {
      void client.invalidateQueries({ queryKey: ['jobs'] })
      handlers.onJobProgress?.(payload)
    },
  )

  socket.on('job.finished', () => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
  })

  socket.on('acl.revoked', (payload: { objectId: string }) => {
    handlers.onAclRevoked?.(payload)
  })

  socket.on('presence', (payload: { objectId: string; users: PresenceUser[] }) => {
    presence.set(payload.objectId, payload.users)
    for (const listener of presenceListeners) listener()
  })

  return socket
}

type ModuleHandler = (payload: unknown) => void
const moduleHandlers = new Map<string, Set<ModuleHandler>>()

/**
 * Подписка модуля на сообщение шлюза (входящий звонок, состав комнаты):
 * переживает переподключение, снимается возвращённой функцией.
 */
export function onRealtimeEvent(event: string, handler: ModuleHandler): () => void {
  const set = moduleHandlers.get(event) ?? new Set<ModuleHandler>()
  set.add(handler)
  moduleHandlers.set(event, set)
  return () => {
    set.delete(handler)
    if (set.size === 0) moduleHandlers.delete(event)
  }
}

export function subscribeRooms(rooms: string[]): void {
  if (!socket || rooms.length === 0) return
  socket.emit('subscribe', { rooms })
}

export function unsubscribeRooms(rooms: string[]): void {
  if (!socket || rooms.length === 0) return
  socket.emit('unsubscribe', { rooms })
}

/** Отметка просмотра видимой вкладки (раз в 30 с) или уход с неё. */
export function reportPresence(objectId: string, state: 'view' | 'leave'): void {
  socket?.emit(state === 'view' ? 'presence.view' : 'presence.leave', { objectId })
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
