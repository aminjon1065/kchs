import type { QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { io, type Socket } from 'socket.io-client'

export type RealtimeStatus = 'connecting' | 'connected' | 'disconnected'

let socket: Socket | null = null
let status: RealtimeStatus = 'disconnected'
const listeners = new Set<() => void>()

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
      handlers.onMessagePosted?.(payload)
    },
  )

  socket.on('notification.new', () => {
    void client.invalidateQueries({ queryKey: ['notifications'] })
    handlers.onNotification?.()
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

  return socket
}

export function subscribeRooms(rooms: string[]): void {
  if (!socket || rooms.length === 0) return
  socket.emit('subscribe', { rooms })
}

export function unsubscribeRooms(rooms: string[]): void {
  if (!socket || rooms.length === 0) return
  socket.emit('unsubscribe', { rooms })
}

export function announcePresence(objectId: string): void {
  socket?.emit('presence.view', { objectId })
}

export function disconnectRealtime(): void {
  socket?.disconnect()
  socket = null
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
