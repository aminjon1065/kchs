import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { useEffect, useState } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { getCsrfToken } from '~/shared/api/client.js'

/**
 * Клиент совместного редактирования (ADR-0070): один сокет `/collab/ws` на
 * вкладку браузера, документы мультиплексируются по имени — идентификатору
 * объекта. Вход — cookie сессии и CSRF-токен в поле `token`. Пока ни один
 * документ не открыт, сокет закрыт.
 */

let socket: HocuspocusProviderWebsocket | null = null
let users = 0

function acquireSocket(): HocuspocusProviderWebsocket {
  if (!socket) {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    socket = new HocuspocusProviderWebsocket({
      url: `${scheme}://${window.location.host}/collab/ws`,
      autoConnect: false,
    })
  }
  users += 1
  if (users === 1) void socket.connect()
  return socket
}

function releaseSocket(): void {
  users = Math.max(0, users - 1)
  if (users === 0) socket?.disconnect()
}

/**
 * Состояние документа: `connecting` — вход и первая синхронизация, `ready` —
 * документ синхронизирован, `offline` — связь потеряна (правки копятся и уйдут
 * при переподключении), `denied` — нет доступа (причина — от сервера).
 */
export type CollabStatus = 'connecting' | 'ready' | 'offline' | 'denied'

export interface CollabDocument {
  doc: Y.Doc
  awareness: Awareness
  status: CollabStatus
  /** Документ хотя бы раз синхронизирован: до этого он пуст и показывать его рано. */
  synced: boolean
  /** Документ открыт только для чтения (нет права `edit`). */
  readOnly: boolean
  /** Правки, ещё не подтверждённые сервером: «Сохраняется…». */
  pending: boolean
  reason: string | null
}

const INITIAL: Omit<CollabDocument, 'doc' | 'awareness'> = {
  status: 'connecting',
  synced: false,
  readOnly: false,
  pending: false,
  reason: null,
}

interface Opened {
  doc: Y.Doc
  provider: HocuspocusProvider
}

/**
 * Открытый совместный документ объекта. Потеря или смена права
 * (`access_changed`) — документ открывается заново и получает новый режим.
 */
export function useCollabDocument(objectId: string): CollabDocument | null {
  const [opened, setOpened] = useState<Opened | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<Omit<CollabDocument, 'doc' | 'awareness'>>(INITIAL)

  // biome-ignore lint/correctness/useExhaustiveDependencies: новая попытка (attempt) — новое подключение
  useEffect(() => {
    const doc = new Y.Doc()
    const provider = new HocuspocusProvider({
      websocketProvider: acquireSocket(),
      name: objectId,
      document: doc,
      token: () => getCsrfToken() ?? '',
      // Один документ может быть открыт в двух панелях: у каждой — своя сессия
      sessionAwareness: true,
      onSynced: () =>
        setState((current) => ({
          ...current,
          status: 'ready',
          synced: true,
          readOnly: provider.authorizedScope === 'readonly',
          reason: null,
        })),
      onAuthenticationFailed: ({ reason }) =>
        setState((current) => ({ ...current, status: 'denied', reason })),
      onStatus: ({ status }) => {
        if (status === 'disconnected') {
          setState((current) =>
            current.status === 'denied' ? current : { ...current, status: 'offline' },
          )
        } else if (status === 'connecting') {
          setState((current) =>
            current.status === 'denied' ? current : { ...current, status: 'connecting' },
          )
        }
      },
      onUnsyncedChanges: ({ number }) =>
        setState((current) =>
          current.pending === number > 0 ? current : { ...current, pending: number > 0 },
        ),
      onClose: ({ event }) => {
        // Права изменились — открыть документ заново и узнать новые
        if (event.reason === 'access_changed') setAttempt((value) => value + 1)
      },
    })
    provider.attach()
    setOpened({ doc, provider })
    setState(INITIAL)
    return () => {
      setOpened(null)
      provider.destroy()
      doc.destroy()
      releaseSocket()
    }
  }, [objectId, attempt])

  if (!opened) return null
  const awareness = opened.provider.awareness
  if (!awareness) return null
  return { doc: opened.doc, awareness, ...state }
}
