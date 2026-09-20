import type { MeetingGuestLink, MeetingJoin } from '@kchs/contracts'
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
import { endMeeting, joinMeeting, leaveMeeting, meetingKeys, meetingQuery } from './queries.js'
import { MeetingRoom } from './room/meeting-room.js'

/**
 * Встреча как объект (ADR-0089, ADR-0091): до входа — карточка с составом и
 * кнопкой входа, после — комната. Вход выдаёт токен медиасервера; на экране
 * встречи он же перевыпускается при переподключении.
 */
export function MeetingView({ objectId }: { objectId: string; tabId?: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const [join, setJoin] = useState<MeetingJoin | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)

  const { data: meeting, isLoading, error } = useQuery(meetingQuery(objectId))

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
                {participant.inRoom ? (
                  <Badge tone="success" size="sm">
                    {t('meetings.room.here')}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <GuestLinkDialog meetingId={objectId} open={linkOpen} onOpenChange={setLinkOpen} />
    </div>
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
