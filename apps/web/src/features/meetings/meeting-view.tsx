import type { MeetingGuestLink, MeetingJoin, MeetingRecord, RecordingList } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Dialog,
  DialogContent,
  EmptyState,
  Input,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Users, Video } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { onRealtimeEvent } from '~/shared/realtime/client.js'
import { ProtocolPanel } from './protocol/protocol-panel.js'
import { endMeeting, joinMeeting, leaveMeeting, meetingKeys, meetingQuery } from './queries.js'
import { MeetingRoom } from './room/meeting-room.js'

/**
 * Встреча как объект (ADR-0089, ADR-0091): до входа — карточка с составом,
 * записями и протоколом (ADR-0092, ADR-0093), после — комната. Вход выдаёт
 * токен медиасервера; на экране встречи он же перевыпускается при
 * переподключении.
 */
export default function MeetingView({ objectId, tabId }: { objectId: string; tabId?: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const [join, setJoin] = useState<MeetingJoin | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)

  const { data: meeting, isLoading, error } = useQuery(meetingQuery(objectId))

  useEffect(() => {
    if (tabId && meeting?.title) setTabTitle(tabId, meeting.title)
  }, [meeting?.title, setTabTitle, tabId])

  // Состав комнаты и завершение приходят realtime: карточка не устаревает
  useEffect(
    () =>
      onRealtimeEvent('meeting.changed', (payload) => {
        if ((payload as { meetingId?: string }).meetingId !== objectId) return
        void client.invalidateQueries({ queryKey: meetingKeys.meeting(objectId) })
        void client.invalidateQueries({ queryKey: meetingKeys.knocks(objectId) })
      }),
    [client, objectId],
  )

  const enter = useMutation({
    mutationFn: () => joinMeeting(objectId),
    onSuccess: (result) => {
      setJoin(result)
      void client.invalidateQueries({ queryKey: meetingKeys.meeting(objectId) })
    },
    onError: (cause) => {
      toast.error(
        cause instanceof ApiError && cause.code === 'service_unavailable'
          ? t('meetings.errors.noMedia')
          : t('meetings.errors.joinFailed'),
      )
    },
  })

  const leave = useCallback(() => {
    setJoin(null)
    void leaveMeeting(objectId).finally(() =>
      client.invalidateQueries({ queryKey: meetingKeys.meeting(objectId) }),
    )
  }, [client, objectId])

  const finish = useMutation({
    mutationFn: () => endMeeting(objectId),
    onSuccess: () => {
      setJoin(null)
      void client.invalidateQueries({ queryKey: meetingKeys.meeting(objectId) })
    },
  })

  // Секретарь ведёт протокол вместе с организатором (N30); протокол заводится назначением
  const secretary = useMutation({
    mutationFn: (userId: string | null) =>
      http.put<MeetingRecord>(`/meetings/${objectId}/secretary`, { userId }),
    onSuccess: (record, userId) => {
      client.setQueryData(meetingKeys.meeting(objectId), record)
      void client.invalidateQueries({ queryKey: meetingKeys.meeting(objectId) })
      toast.show({
        title: t(userId ? 'meetings.secretary.assigned' : 'meetings.secretary.removed'),
        tone: 'success',
      })
    },
    onError: (cause) =>
      toast.error(cause instanceof ApiError ? cause.message : t('errors.unknown')),
  })

  const refreshToken = useCallback(() => joinMeeting(objectId), [objectId])

  if (isLoading) return <Skeleton className="m-6 h-64" />
  if (error || !meeting) {
    return (
      <div className="p-6">
        <EmptyState icon={<Video />} title={t('meetings.errors.notFound')} />
      </div>
    )
  }

  if (join) {
    return (
      <MeetingRoom
        title={meeting.title}
        meeting={meeting}
        join={join}
        refreshToken={refreshToken}
        onLeave={leave}
        onEnd={() => finish.mutate()}
        onShow={(object) => {
          openTab({
            kind: 'object',
            objectId: object.objectId,
            objectType: object.objectType,
            title: object.title,
            mode: 'background',
          })
          toast.show({ title: t('meetings.room.showedToYou', { title: object.title }) })
        }}
      />
    )
  }

  const when = meeting.startsAt ? formatDateTime(meeting.startsAt, { locale }) : null

  return (
    <Tabs defaultValue="overview" className="flex h-full min-h-0 flex-col">
      <TabsList className="px-6 pt-4">
        <TabsTrigger value="overview">{t('meetings.tabs.overview')}</TabsTrigger>
        <TabsTrigger value="protocol">{t('meetings.protocol.tab')}</TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 p-6">
          <header className="flex flex-wrap items-center gap-3">
            <h1 className="text-lg font-semibold">{meeting.title}</h1>
            <Badge tone={meeting.status === 'live' ? 'success' : 'neutral'}>
              {t(`meetings.status.${meeting.status}`)}
            </Badge>
            {when ? <span className="text-sm text-fg-secondary">{when}</span> : null}
          </header>

          {meeting.can.join ? null : (
            <Callout tone="warning">{t('meetings.errors.unavailable')}</Callout>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={!meeting.can.join}
              loading={enter.isPending}
              onClick={() => enter.mutate()}
              data-testid="meeting-join"
              icon={<Video className="size-4" />}
            >
              {t('meetings.actions.join')}
            </Button>
            {meeting.can.manage ? (
              <Button
                variant="secondary"
                onClick={() => setLinkOpen(true)}
                data-testid="meeting-guest-link"
                icon={<Link2 className="size-4" />}
              >
                {t('meetings.actions.guestLink')}
              </Button>
            ) : null}
            {meeting.can.end ? (
              <Button variant="ghost" onClick={() => finish.mutate()} loading={finish.isPending}>
                {t('meetings.room.endForAll')}
              </Button>
            ) : null}
          </div>

          <section className="flex flex-col gap-2">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <Users className="size-4" aria-hidden />
              {t('meetings.room.invited')}
            </h2>
            {meeting.participants.length === 0 ? (
              <p className="text-sm text-fg-muted">{t('meetings.room.noInvited')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {meeting.participants.map((participant) => (
                  <li key={participant.user.id} className="flex items-center gap-2">
                    <Avatar
                      name={participant.user.displayName}
                      src={participant.user.avatarUrl}
                      size="sm"
                    />
                    <span className="text-sm">{participant.user.displayName}</span>
                    {participant.role === 'organizer' ? (
                      <Badge tone="accent" size="sm">
                        {t('meetings.role.organizer')}
                      </Badge>
                    ) : null}
                    {participant.role === 'secretary' ? (
                      <Badge tone="purple" size="sm">
                        {t('meetings.role.secretary')}
                      </Badge>
                    ) : null}
                    {participant.inRoom ? (
                      <Badge tone="success" size="sm">
                        {t('meetings.room.here')}
                      </Badge>
                    ) : null}
                    {meeting.can.manage &&
                    (participant.role === 'participant' || participant.role === 'secretary') ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto"
                        disabled={secretary.isPending}
                        onClick={() =>
                          secretary.mutate(
                            participant.role === 'secretary' ? null : participant.user.id,
                          )
                        }
                        aria-label={t(
                          participant.role === 'secretary'
                            ? 'meetings.secretary.removeLabel'
                            : 'meetings.secretary.assignLabel',
                          { name: participant.user.displayName },
                        )}
                      >
                        {t(
                          participant.role === 'secretary'
                            ? 'meetings.secretary.remove'
                            : 'meetings.secretary.assign',
                        )}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <RecordingsSection meetingId={objectId} />
        </div>
      </TabsContent>

      <TabsContent value="protocol" className="min-h-0 flex-1">
        <ProtocolPanel meetingId={objectId} />
      </TabsContent>

      <GuestLinkDialog meetingId={objectId} open={linkOpen} onOpenChange={setLinkOpen} />
    </Tabs>
  )
}

/** Записи встречи (ADR-0092): доступны тем же, кому доступна сама встреча. */
function RecordingsSection({ meetingId }: { meetingId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const { data } = useQuery({
    queryKey: meetingKeys.recordings(meetingId),
    queryFn: () => http.get<RecordingList>(`/meetings/${meetingId}/recordings`),
  })
  const items = data?.items ?? []
  if (items.length === 0) return null

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">{t('meetings.recording.listTitle')}</h2>
      <ul className="flex flex-col gap-1" aria-label={t('meetings.recording.listTitle')}>
        {items.map((recording) => (
          <li key={recording.id} className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                openTab({
                  kind: 'object',
                  objectId: recording.id,
                  objectType: 'recording',
                  title: recording.title,
                  mode: 'permanent',
                })
              }
            >
              {recording.startedAt
                ? formatDateTime(recording.startedAt, { locale })
                : recording.title}
            </Button>
            <Badge tone={recording.status === 'ready' ? 'success' : 'neutral'} size="sm">
              {t(`meetings.recording.status.${recording.status}`)}
            </Badge>
            {recording.pinnedAt ? (
              <Badge tone="accent" size="sm">
                {t('meetings.recording.retention.pinned')}
              </Badge>
            ) : recording.expiresAt ? (
              <span className="text-xs text-fg-muted">
                {t('meetings.recording.retention.expires', {
                  date: formatDateTime(recording.expiresAt, { locale }),
                })}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Ссылка для гостя: срок ограничен, доступа к объектам не даёт (ADR-0091). */
function GuestLinkDialog({
  meetingId,
  open,
  onOpenChange,
}: {
  meetingId: string
  open: boolean
  onOpenChange: (next: boolean) => void
}) {
  const t = useT()
  const toast = useToast()
  const [link, setLink] = useState<MeetingGuestLink | null>(null)
  const locale = useAppearance((s) => s.locale)

  const create = useMutation({
    mutationFn: (ttlMinutes: number) =>
      http.post<MeetingGuestLink>(`/meetings/${meetingId}/guest-link`, { ttlMinutes }),
    onSuccess: (result) => setLink(result),
    onError: () => toast.error(t('meetings.errors.linkFailed')),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t('meetings.actions.guestLink')} size="sm">
        <p className="text-sm text-fg-secondary">{t('meetings.guest.hint')}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {[60, 240, 1440].map((minutes) => (
            <Button
              key={minutes}
              size="sm"
              variant="secondary"
              loading={create.isPending}
              onClick={() => create.mutate(minutes)}
            >
              {t(`meetings.guest.ttl.${minutes}`)}
            </Button>
          ))}
        </div>
        {link ? (
          <div className="mt-3 flex flex-col gap-2">
            <Input readOnly value={link.url} data-testid="meeting-guest-url" />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(link.url)
                  toast.success(t('common.actions.copyLink'))
                }}
              >
                {t('common.actions.copyLink')}
              </Button>
              <span className="text-xs text-fg-muted">
                {t('meetings.guest.until', { when: formatDateTime(link.expiresAt, { locale }) })}
              </span>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
