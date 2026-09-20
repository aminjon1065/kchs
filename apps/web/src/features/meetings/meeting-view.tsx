import {
  Avatar,
  Badge,
  KeyValueList,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ProtocolPanel } from './protocol/protocol-panel.js'
import { meetingQuery } from './protocol/queries.js'

/**
 * Карточка встречи (11-communications-meetings.md §3–4): состав и время —
 * «Сведения», повестка и протокол — «Протокол» (ADR-0093). Комната и запись
 * приходят сюда своими вкладками.
 */
export default function MeetingView({ objectId, tabId }: { objectId: string; tabId: string }) {
  const t = useT()
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const { data: meeting, isLoading } = useQuery(meetingQuery(objectId))

  useEffect(() => {
    if (meeting?.title) setTabTitle(tabId, meeting.title)
  }, [meeting?.title, setTabTitle, tabId])

  if (isLoading || !meeting) return <Skeleton className="m-4 h-40" />

  return (
    <Tabs defaultValue="overview" className="flex h-full min-h-0 flex-col">
      <TabsList className="px-4 pt-3">
        <TabsTrigger value="overview">{t('meetings.tabs.overview')}</TabsTrigger>
        <TabsTrigger value="protocol">{t('meetings.protocol.tab')}</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-md font-semibold text-fg">{meeting.title}</h2>
            <Badge tone={meeting.status === 'live' ? 'success' : 'neutral'}>
              {t(`meetings.statuses.${meeting.status}`)}
            </Badge>
          </div>
          <KeyValueList
            items={[
              {
                key: 'organizer',
                label: t('meetings.organizer'),
                value: meeting.organizer?.displayName ?? '—',
              },
              {
                key: 'participants',
                label: t('meetings.participantsCount'),
                value: String(meeting.participants.length),
              },
            ]}
          />
          <ul className="flex flex-col gap-1" aria-label={t('meetings.participants')}>
            {meeting.participants.map((item) => (
              <li key={item.user.id} className="flex items-center gap-2 text-sm text-fg">
                <Avatar name={item.user.displayName} src={item.user.avatarUrl} size="sm" />
                {item.user.displayName}
              </li>
            ))}
          </ul>
        </div>
      </TabsContent>
      <TabsContent value="protocol" className="min-h-0 flex-1">
        <ProtocolPanel meetingId={objectId} />
      </TabsContent>
    </Tabs>
  )
}
