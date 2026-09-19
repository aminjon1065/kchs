import type { DocumentRecord } from '@kchs/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { createContext, type ReactNode, useCallback, useContext, useMemo } from 'react'
import { documentKeys } from '../queries.js'

/**
 * Общий контекст карточки документа (03-screens.md §12): вкладки и действия
 * второй волны — маршрут, резолюции, связи, ознакомление, действия шага —
 * пишутся каждая в свой файл-слот и получают документ отсюда, не трогая
 * общую карточку.
 */
export interface DocumentContextValue {
  document: DocumentRecord
  /** Вкладка оболочки, в которой открыта карточка (для состояния и заголовка). */
  tabId: string | null
  /** Перечитать карточку и связанные списки после действия. */
  refresh: () => void
  /** Переключить вкладку карточки (например, из действия шага — на «Маршрут»). */
  openSection: (section: DocumentSection) => void
}

export const DOCUMENT_SECTIONS = [
  'card',
  'files',
  'route',
  'resolutions',
  'links',
  'acknowledgments',
  'history',
] as const
export type DocumentSection = (typeof DOCUMENT_SECTIONS)[number]

const Context = createContext<DocumentContextValue | null>(null)

export function DocumentProvider({
  document,
  tabId,
  openSection,
  children,
}: {
  document: DocumentRecord
  tabId: string | null
  openSection?: (section: DocumentSection) => void
  children: ReactNode
}) {
  const client = useQueryClient()
  const refresh = useCallback(() => {
    void client.invalidateQueries({ queryKey: ['object', document.id] })
    void client.invalidateQueries({ queryKey: documentKeys.all })
    void client.invalidateQueries({ queryKey: ['objects'] })
  }, [client, document.id])
  const value = useMemo<DocumentContextValue>(
    () => ({ document, tabId, refresh, openSection: openSection ?? (() => undefined) }),
    [document, tabId, refresh, openSection],
  )
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useDocument(): DocumentContextValue {
  const value = useContext(Context)
  // i18n-ignore — сообщение для разработчика, не текст интерфейса
  if (!value) throw new Error('useDocument вне DocumentProvider')
  return value
}
