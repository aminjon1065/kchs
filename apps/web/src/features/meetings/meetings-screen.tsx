import type { MeetingRecord } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import { AvatarGroup, Badge, Button, Callout, Card, EmptyState, Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Video } from 'lucide-react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { meetingsQuery, meetingsStatusQuery } from './queries.js'

/**
 * Экран «Встречи» (03-screens.md, 11-communications-meetings.md §3): идущие
 * сейчас и мои — со входом в комнату одной кнопкой.
 */
export function MeetingsScreen() {
  const t = useT()
  const { data: status } = useQuery(meetingsStatusQuery())
  const live = useQuery(meetingsQuery('live'))
  const mine = useQuery(meetingsQuery('mine'))

  const liveIds = new Set((live.data?.items ?? []).map((item) => item.id))
  const upcoming = (mine.data?.items ?? []).filter((item) => !liveIds.has(item.id))

  return (
    <div className="flex flex-col gap-5 overflow-y-auto p-6">
      <h1 className="text-lg font-semibold">{t('shell.rail.meetings')}</h1>

      {status && !status.enabled ? (
        <Callout tone="warning" title={t('meetings.errors.unavailable')}>
          {t('meetings.errors.unavailableHint')}
        </Callout>
      ) : null}

      <Section
        title={t('meetings.list.live')}
        loading={live.isLoading}
        items={live.data?.items ?? []}
        emptyTitle={t('meetings.list.noLive')}
      />
      <Section
        title={t('meetings.list.mine')}
        loading={mine.isLoading}
        items={upcoming}
        emptyTitle={t('meetings.list.noMine')}
      />
    </div>
  )
}

function Section({
  title,
  loading,
  items,
  emptyTitle,
}: {
  title: string
  loading: boolean
  items: MeetingRecord[]
  emptyTitle: string
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-fg-secondary">{title}</h2>
      {loading ? (
        <Skeleton className="h-20 w-full" />
      ) : items.length === 0 ? (
        <EmptyState compact icon={<Video />} title={emptyTitle} />
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {items.map((meeting) => (
            <MeetingCard key={meeting.id} meeting={meeting} />
          ))}
        </div>
      )}
    </section>
  )
}

function MeetingCard({ meeting }: { meeting: MeetingRecord }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)

  const open = () =>
    openTab({
      kind: 'object',
      objectId: meeting.id,
      objectType: 'meeting',
      title: meeting.title,
      mode: 'permanent',
    })

  return (
    <Card className="flex flex-col gap-2 p-3" data-testid="meeting-card">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{meeting.title}</span>
        <Badge tone={meeting.status === 'live' ? 'success' : 'neutral'} size="sm">
          {t(`meetings.status.${meeting.status}`)}
        </Badge>
      </div>
      <div className="flex items-center gap-2 text-xs text-fg-secondary">
        {meeting.startsAt ? <span>{formatDateTime(meeting.startsAt, { locale })}</span> : null}
        {meeting.inRoom > 0 ? (
          <span>{t('meetings.list.inRoom', { count: meeting.inRoom })}</span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <AvatarGroup
          people={meeting.participants.map((participant) => ({
            name: participant.user.displayName,
            src: participant.user.avatarUrl,
          }))}
          size="sm"
        />
        <Button size="sm" className="ml-auto" onClick={open} data-testid="meeting-open">
          {meeting.can.join ? t('meetings.actions.join') : t('common.actions.open')}
        </Button>
      </div>
    </Card>
  )
}
