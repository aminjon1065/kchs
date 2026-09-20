import type { UserRef } from '@kchs/contracts'
import type { Collaborator } from '@kchs/ui'
import { createContext, useContext } from 'react'
import type { Awareness } from 'y-protocols/awareness'

/**
 * Общее состояние вкладки протокола: режим документа, присутствие соавторов и
 * участники встречи (из них выбирается исполнитель поручения).
 */
export interface ProtocolContextValue {
  readOnly: boolean
  awareness: Awareness | null
  user: Collaborator
  participants: UserRef[]
}

const ProtocolContext = createContext<ProtocolContextValue | null>(null)

export const ProtocolProvider = ProtocolContext.Provider

export function useProtocol(): ProtocolContextValue {
  const value = useContext(ProtocolContext)
  // i18n-ignore — сообщение разработчику, не текст интерфейса
  if (!value) throw new Error('useProtocol: нет ProtocolProvider')
  return value
}
