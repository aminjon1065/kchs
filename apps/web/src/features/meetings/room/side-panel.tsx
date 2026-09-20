import type { MeetingRecord } from '@kchs/contracts'
import { Avatar, Badge, Button, EmptyState, Skeleton } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Hand, MessageSquare, MicOff, Users } from 'lucide-react'
import { useT } from '~/app/i18n.js'
import { type ComposedMessage, MessageComposer } from '~/features/discussion/message-composer.js'
import { MessageItem } from '~/features/discussion/message-item.js'
import { http } from '~/shared/api/client.js'
import { discussionQuery, keys } from '~/shared/api/queries.js'
import { decideKnock, meetingKeys, meetingKnocksQuery } from '../queries.js'
import { QualityIcon } from './media.js'
import type { MeetingRoomApi } from './use-meeting-room.js'

/**
 * Боковая панель комнаты: участники с их состоянием и чат встречи. Чат — это
 * обсуждение объекта встречи (11-communications-meetings.md §3), поэтому он
 * остаётся и после её завершения.
 */
export function PeoplePanel({ meeting, room }: { meeting: MeetingRecord; room: MeetingRoomApi }) {
  const t = useT()
  const inRoom = new Map(
    room.tiles.filter((tile) => !tile.isScreen).map((tile) => [tile.identity, tile]),
  )

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <KnockList meeting={meeting} />

      <section className="flex flex-col gap-1">
        <h3 className="text-2xs uppercase tracking-wide text-fg-muted">
          {t('meetings.room.inRoom', { count: inRoom.size })}
        </h3>
        {[...inRoom.values()].map((tile) => (
          <div key={tile.identity} className="flex items-center gap-2 rounded-md px-1 py-1">
            <Avatar name={tile.name} size="sm" />
            <span className="min-w-0 flex-1 truncate text-sm">{tile.name}</span>
            {tile.hand ? <Hand className="size-3.5 text-warning" aria-hidden /> : null}
            {tile.micOn ? null : <MicOff className="size-3.5 text-fg-muted" aria-hidden />}
            <QualityIcon quality={tile.quality} />
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-2xs uppercase tracking-wide text-fg-muted">
          {t('meetings.room.invited')}
        </h3>
        {meeting.participants.length === 0 ? (
          <EmptyState compact icon={<Users />} title={t('meetings.room.noInvited')} />
        ) : (
          meeting.participants.map((participant) => (
            <div key={participant.user.id} className="flex items-center gap-2 px-1 py-1">
              <Avatar
                name={participant.user.displayName}
                src={participant.user.avatarUrl}
                size="sm"
              />
              <span className="min-w-0 flex-1 truncate text-sm">
                {participant.user.displayName}
              </span>
              {participant.role === 'organizer' ? (
                <Badge tone="accent" size="sm">
                  {t('meetings.role.organizer')}
                </Badge>
              ) : null}
              {inRoom.has(participant.user.id) ? (
                <Badge tone="success" size="sm">
                  {t('meetings.room.here')}
                </Badge>
              ) : null}
            </div>
          ))
        )}
      </section>
    </div>
  )
}

/** Комната ожидания: гости по ссылке ждут разрешения ведущего (ADR-0091). */
function KnockList({ meeting }: { meeting: MeetingRecord }) {
  const t = useT()
  const client = useQueryClient()
  const { data } = useQuery(meetingKnocksQuery(meeting.id, meeting.can.manage))
  const decide = useMutation({
    mutationFn: ({ requestId, admit }: { requestId: string; admit: boolean }) =>
      decideKnock(meeting.id, requestId, admit),
    onSuccess: () => void client.invalidateQueries({ queryKey: meetingKeys.knocks(meeting.id) }),
  })

  if (!data?.items.length) return null

  return (
    <section className="flex flex-col gap-1 rounded-md border border-line bg-surface-2 p-2">
      <h3 className="text-2xs uppercase tracking-wide text-fg-muted">
        {t('meetings.waiting.title')}
      </h3>
      {data.items.map((item) => (
        <div key={item.id} className="flex items-center gap-2" data-testid="meeting-knock">
          <Avatar name={item.name} size="sm" />
          <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
          <Button
            size="sm"
            variant="primary"
            data-testid="meeting-admit"
            onClick={() => decide.mutate({ requestId: item.id, admit: true })}
          >
            {t('meetings.waiting.admit')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => decide.mutate({ requestId: item.id, admit: false })}
          >
            {t('meetings.waiting.deny')}
          </Button>
        </div>
      ))}
    </section>
  )
}

/** Чат встречи — обсуждение её объекта: те же сообщения, что в контекст-панели. */
export function MeetingChat({ meetingId }: { meetingId: string }) {
  const t = useT()
  const client = useQueryClient()
  const { data, isLoading } = useQuery(discussionQuery(meetingId))

  const post = useMutation({
    mutationFn: (message: ComposedMessage) =>
      http.post(`/objects/${meetingId}/discussion/messages`, {
        body: message.body,
        text: message.text,
        attachments: message.attachments.map((fileId) => ({ fileId })),
        mentions: message.mentions,
        mentionedObjectIds: [],
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.discussion(meetingId) }),
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !data?.items.length ? (
          <EmptyState
            compact
            icon={<MessageSquare />}
            title={t('meetings.room.chatEmpty')}
            description={t('meetings.room.chatHint')}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {data.items.map((message) => (
              <MessageItem key={message.id} message={message} objectId={meetingId} canReact />
            ))}
          </div>
        )}
      </div>
      <MessageComposer
        onSend={(message) => post.mutateAsync(message)}
        pending={post.isPending}
        placeholder={t('meetings.room.chatPlaceholder')}
      />
    </div>
  )
}
