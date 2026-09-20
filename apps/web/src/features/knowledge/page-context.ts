import type { Collaborator } from '@kchs/ui'
import { createContext, useContext } from 'react'
import type { Awareness } from 'y-protocols/awareness'

/**
 * Общее состояние карточки страницы: режим документа, присутствие соавторов и
 * пространство (из него выбираются встроенные объекты и файлы).
 */
export interface PageContextValue {
  pageId: string
  spaceId: string
  readOnly: boolean
  awareness: Awareness | null
  user: Collaborator
  /** Открыть обсуждение с якорем на блок — комментарий к фрагменту. */
  onComment: (blockId: string) => void
}

const PageContext = createContext<PageContextValue | null>(null)

export const PageProvider = PageContext.Provider

export function usePageContext(): PageContextValue {
  const value = useContext(PageContext)
  // i18n-ignore — сообщение разработчику, не текст интерфейса
  if (!value) throw new Error('usePageContext: нет PageProvider')
  return value
}
