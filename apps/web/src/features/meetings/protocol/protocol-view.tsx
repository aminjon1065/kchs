import { Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useWorkspace } from '~/app/workspace/store.js'
import { ProtocolBody } from './protocol-panel.js'
import { protocolQuery } from './queries.js'

/**
 * Протокол отдельной вкладкой (ADR-0093): так его открывают дело Входящих
 * «Проверить протокол», поиск и связи. Содержимое — то же, что во вкладке
 * «Протокол» карточки встречи.
 */
export default function ProtocolView({ objectId, tabId }: { objectId: string; tabId: string }) {
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const { data: protocol } = useQuery(protocolQuery(objectId))

  useEffect(() => {
    if (protocol?.title) setTabTitle(tabId, protocol.title)
  }, [protocol?.title, setTabTitle, tabId])

  if (!protocol) return <Skeleton className="m-4 h-40" />
  return <ProtocolBody protocolId={protocol.id} meetingId={protocol.meetingId} />
}
