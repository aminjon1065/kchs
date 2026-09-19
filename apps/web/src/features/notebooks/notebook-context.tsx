import type { NotebookParams } from '@kchs/contracts'
import type { Collaborator } from '@kchs/ui'
import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'

/** Открытая тетрадь: документ, присутствие, права и параметры — ячейкам без проброса. */
export interface NotebookContextValue {
  notebookId: string
  spaceId: string | null
  doc: Y.Doc
  awareness: Awareness
  readOnly: boolean
  params: NotebookParams
  /** Кто пишет: подпись и цвет курсора у соавторов. */
  user: Collaborator
  timezone: string
  canSql: boolean
}

const NotebookContext = createContext<NotebookContextValue | null>(null)

export const NotebookProvider = NotebookContext.Provider

export function useNotebook(): NotebookContextValue {
  const value = useContext(NotebookContext)
  // i18n-ignore — ошибка разработчика: ячейка вне экрана тетради
  if (!value) throw new Error('useNotebook: нет NotebookProvider')
  return value
}

/** Соавтор в документе: кто он и в какой ячейке сейчас. */
export interface Peer {
  clientId: number
  name: string
  tone: Collaborator['tone']
  cell: string | null
}

function peersOf(awareness: Awareness): Peer[] {
  const peers: Peer[] = []
  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === awareness.clientID) continue
    const user = state.user as Partial<Collaborator> | undefined
    if (!user?.name) continue
    peers.push({
      clientId,
      name: user.name,
      tone: user.tone ?? 1,
      cell: typeof state.cell === 'string' ? state.cell : null,
    })
  }
  return peers.sort((a, b) => a.name.localeCompare(b.name))
}

/** Соавторы, открывшие документ (кроме себя), — с перерисовкой при их изменениях. */
export function usePeers(awareness: Awareness): Peer[] {
  const cache = useRef<{ key: string; peers: Peer[] }>({ key: '', peers: [] })
  const subscribe = useCallback(
    (notify: () => void) => {
      awareness.on('change', notify)
      return () => awareness.off('change', notify)
    },
    [awareness],
  )
  // Снимок меняется только вместе с составом соавторов и их ячейками
  const snapshot = () => {
    const peers = peersOf(awareness)
    const key = JSON.stringify(peers)
    if (key !== cache.current.key) cache.current = { key, peers }
    return cache.current.peers
  }
  return useSyncExternalStore(subscribe, snapshot)
}
