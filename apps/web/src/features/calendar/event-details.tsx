import type { EventEditScope, EventRecord, ResponseStatus } from '@kchs/contracts'
import {
  AlertDialog,
  Avatar,
  Badge,
  Button,
  Callout,
  cn,
  Dialog,
  DialogContent,
  Field,
  Input,
  ObjectChip,
  Textarea,
  Tooltip,
  toneClasses,
  useToast,
} from '@kchs/ui'
import { useMutation } from '@tanstack/react-query'
import {
  Bell,
  CalendarDays,
  Clock,
  ExternalLink,
  Lock,
  MapPin,
  Pencil,
  Repeat,
  Trash2,
  Users,
  Video,
} from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { reminderLabel } from './event-editor.js'
import { useCalendarFormat } from './format.js'
import { useCalendarInvalidation } from './queries.js'
import { describeRule, parseRule } from './recurrence.js'
import { ScopeDialog } from './scope-dialog.js'
import { clockMinutes, clockText, instantAt, wallOf } from './time.js'

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  accepted: 'success',
  tentative: 'warning',
  declined: 'danger',
  needs_action: 'neutral',
}

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-2.5 text-sm text-fg">
      <span className="mt-0.5 shrink-0 text-fg-muted" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/**
 * Карточка события — в поповере сетки и во вкладке объекта: время, повтор,
 * место и ресурсы, участники с ответами, описание, связанные объекты; ответ на
 * приглашение (да / возможно / нет / другое время), правка и отмена.
 */
export function EventDetails({
  record,
  compact = false,
  onEdit,
  onClosed,
}: {
  record: EventRecord
  compact?: boolean
  onEdit?: () => void
  /** После отмены события (поповер закрывается). */
  onClosed?: () => void
}) {
  const t = useT()
  const toast = useToast()
  const format = useCalendarFormat()
  const invalidate = useCalendarInvalidation()
  const openTab = useWorkspace((s) => s.openTab)
  const [deleting, setDeleting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [proposing, setProposing] = useState(false)
  const occurrence = record.occurrence
  const time = {
    startsAt: occurrence?.startsAt ?? record.startsAt,
    endsAt: occurrence?.endsAt ?? record.endsAt,
    allDay: record.allDay,
    startDate: occurrence?.startDate ?? record.startDate,
    endDate: occurrence ? occurrence.endDate : record.endDate,
  }
  const color = record.color ?? record.calendar.color

  const respond = useMutation({
    mutationFn: (input: { status: ResponseStatus; comment?: string; proposal?: unknown }) =>
      http.post<EventRecord>(`/events/${record.id}/respond`, input),
    onSuccess: () => {
      invalidate(record.id)
      toast.show({ title: t('calendar.respond.sent'), tone: 'success' })
      setProposing(false)
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const cancel = useMutation({
    mutationFn: (scope: EventEditScope) =>
      http.post(`/events/${record.id}/cancel`, {
        scope,
        ...(scope !== 'series' && occurrence ? { recurrenceId: occurrence.recurrenceId } : {}),
      }),
    onSuccess: () => {
      invalidate(record.id)
      toast.show({ title: t('calendar.event.cancelled'), tone: 'info' })
      setDeleting(false)
      setConfirming(false)
      onClosed?.()
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const acceptProposal = useMutation({
    mutationFn: (proposal: { startsAt: string; endsAt: string; recurrenceId: string | null }) =>
      http.patch(`/events/${record.id}`, {
        ...(record.rrule && proposal.recurrenceId
          ? { scope: 'occurrence', recurrenceId: proposal.recurrenceId }
          : { scope: 'series' }),
        startsAt: proposal.startsAt,
        endsAt: proposal.endsAt,
      }),
    onSuccess: () => {
      invalidate(record.id)
      toast.show({ title: t('calendar.event.saved'), tone: 'success' })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  if (record.busy) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Lock className="size-4 text-fg-muted" aria-hidden />
          <span className="font-semibold text-fg">{t('calendar.busy')}</span>
        </div>
        <Row icon={<Clock className="size-4" />}>{format.when(time)}</Row>
        <p className="text-xs text-fg-muted">{t('calendar.event.busyHint')}</p>
      </div>
    )
  }

  const rule = parseRule(record.rrule, format.timezone)
  const going = record.attendees.filter((item) => item.status === 'accepted').length
  const proposals = record.can.edit
    ? record.attendees.filter((item) => item.proposal && item.role === 'attendee')
    : []

  const openEvent = () =>
    openTab({
      kind: 'object',
      objectId: record.id,
      objectType: 'event',
      title: record.title,
      mode: 'permanent',
    })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden
          className={cn('mt-1.5 size-3 shrink-0 rounded-sm', toneClasses(color).dot)}
        />
        <div className="min-w-0 flex-1">
          <h2 className={cn('font-semibold text-fg', compact ? 'text-md' : 'text-xl')}>
            {record.title}
          </h2>
          <p className="text-sm text-fg-secondary">{format.when(time)}</p>
        </div>
        {record.visibility !== 'public' ? (
          <Tooltip content={t(`calendar.visibilityHint.${record.visibility}`)}>
            <Badge size="sm" tone="neutral">
              <Lock className="size-3" aria-hidden />
              {t(`calendar.visibility.${record.visibility}`)}
            </Badge>
          </Tooltip>
        ) : null}
      </div>

      {rule ? (
        <Row icon={<Repeat className="size-4" />}>
          {describeRule(rule, t, format.intlLocale, format.shortDate)}
        </Row>
      ) : null}
      <Row icon={<CalendarDays className="size-4" />}>
        {record.calendar.kind === 'personal' && record.organizer
          ? t('calendar.event.inCalendarOf', { name: record.organizer.displayName })
          : record.calendar.title}
      </Row>
      {record.location || record.resources.length > 0 ? (
        <Row icon={<MapPin className="size-4" />}>
          {[record.location, ...record.resources.map((item) => item.title)]
            .filter(Boolean)
            .join(' · ')}
        </Row>
      ) : null}
      {/* Онлайн-встреча события: вход в комнату из карточки (ADR-0091) */}
      <Row icon={<Video className="size-4" />}>
        <span className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={!record.meetingId}
            data-testid="event-join-meeting"
            onClick={() =>
              record.meetingId &&
              openTab({
                kind: 'object',
                objectId: record.meetingId,
                objectType: 'meeting',
                title: record.title,
                mode: 'permanent',
              })
            }
          >
            {t('calendar.event.join')}
          </Button>
          {record.meetingId ? null : (
            <span className="text-xs text-fg-muted">{t('calendar.event.meetingOff')}</span>
          )}
        </span>
      </Row>

      {record.attendees.length > 1 ? (
        <Row icon={<Users className="size-4" />}>
          <p className="text-xs text-fg-muted">
            {t('calendar.event.attendeesSummary', {
              count: record.attendees.length,
              going,
            })}
          </p>
          <ul className="mt-1 flex flex-col gap-1" aria-label={t('calendar.event.attendees')}>
            {record.attendees.slice(0, compact ? 6 : 100).map((item) => (
              <li key={item.user.id} className="flex items-center gap-2">
                <Avatar name={item.user.displayName} src={item.user.avatarUrl} size="xs" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {item.user.displayName}
                  {item.optional ? (
                    <span className="text-fg-muted"> · {t('calendar.event.optional')}</span>
                  ) : null}
                </span>
                <Badge
                  size="sm"
                  tone={item.role === 'organizer' ? 'accent' : STATUS_TONE[item.status]}
                >
                  {item.role === 'organizer'
                    ? t('calendar.status.organizer')
                    : t(`calendar.status.${item.status}`)}
                </Badge>
              </li>
            ))}
            {compact && record.attendees.length > 6 ? (
              <li className="text-xs text-fg-muted">
                {t('calendar.event.andMore', { count: record.attendees.length - 6 })}
              </li>
            ) : null}
          </ul>
        </Row>
      ) : null}

      {record.description ? (
        <p
          className={cn('whitespace-pre-line text-sm text-fg-secondary', compact && 'line-clamp-4')}
        >
          {record.description}
        </p>
      ) : null}

      {record.linkedObjects.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {record.linkedObjects.map((object) => (
            <ObjectChip
              key={object.id}
              object={object}
              size="sm"
              onOpen={(item) =>
                openTab({
                  kind: 'object',
                  objectId: item.id,
                  objectType: item.type,
                  title: item.title,
                  mode: 'permanent',
                })
              }
            />
          ))}
        </div>
      ) : null}

      {!compact && (record.myReminders ?? record.reminders).length > 0 ? (
        <Row icon={<Bell className="size-4" />}>
          {(record.myReminders ?? record.reminders)
            .map(
              (reminder) =>
                `${reminderLabel(reminder.minutes, t)} (${reminder.channels
                  .map((channel) => t(`calendar.reminders.channels.${channel}`))
                  .join(', ')})`,
            )
            .join('; ')}
        </Row>
      ) : null}

      {proposals.map((item) =>
        item.proposal ? (
          <Callout key={item.user.id} tone="info">
            <span className="flex flex-wrap items-center gap-2">
              {t('calendar.respond.proposedBy', {
                name: item.user.displayName,
                when: format.when({
                  startsAt: item.proposal.startsAt,
                  endsAt: item.proposal.endsAt,
                  allDay: false,
                  startDate: null,
                  endDate: null,
                }),
              })}
              <Button
                size="sm"
                variant="secondary"
                loading={acceptProposal.isPending}
                onClick={() => item.proposal && acceptProposal.mutate(item.proposal)}
              >
                {t('calendar.respond.acceptProposal')}
              </Button>
            </span>
          </Callout>
        ) : null,
      )}

      {record.source === 'subscription' ? (
        <p className="text-xs text-fg-muted">{t('calendar.event.fromSubscription')}</p>
      ) : null}

      {record.can.respond ? (
        <fieldset className="flex min-w-0 flex-col gap-1.5 border-t border-line pt-3">
          <legend className="float-left mb-1.5 text-xs font-medium text-fg-secondary">
            {t('calendar.respond.title')}
          </legend>
          <div className="clear-left flex flex-wrap gap-1.5">
            {(['accepted', 'tentative', 'declined'] as const).map((status) => (
              <Button
                key={status}
                size="sm"
                variant={record.myStatus === status ? 'primary' : 'secondary'}
                aria-pressed={record.myStatus === status}
                loading={respond.isPending && respond.variables?.status === status}
                onClick={() => respond.mutate({ status })}
              >
                {t(`calendar.respond.${status}`)}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setProposing(true)}>
              {t('calendar.respond.propose')}
            </Button>
          </div>
        </fieldset>
      ) : null}

      <div className="flex flex-wrap gap-1.5 border-t border-line pt-3">
        {record.can.edit && onEdit ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<Pencil className="size-3.5" />}
            onClick={onEdit}
          >
            {t('calendar.event.edit')}
          </Button>
        ) : null}
        {record.can.cancel ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 className="size-3.5" />}
            onClick={() => (record.rrule && occurrence ? setDeleting(true) : setConfirming(true))}
            loading={cancel.isPending}
          >
            {t('calendar.event.delete')}
          </Button>
        ) : null}
        {compact ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            icon={<ExternalLink className="size-3.5" />}
            onClick={openEvent}
          >
            {t('calendar.event.details')}
          </Button>
        ) : null}
      </div>

      <AlertDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t(record.rrule ? 'calendar.event.deleteSeriesTitle' : 'calendar.event.deleteTitle')}
        description={
          record.attendees.length > 1
            ? t('calendar.event.deleteNotifies')
            : t('calendar.event.deleteHint')
        }
        confirmLabel={t('calendar.event.delete')}
        loading={cancel.isPending}
        onConfirm={() => cancel.mutate('series')}
      />
      {deleting ? (
        <ScopeDialog
          mode="delete"
          loading={cancel.isPending}
          onClose={() => setDeleting(false)}
          onConfirm={(scope) => cancel.mutate(scope)}
        />
      ) : null}
      {proposing ? (
        <ProposeDialog
          record={record}
          onClose={() => setProposing(false)}
          onSend={(proposal, comment) =>
            respond.mutate({
              status: record.myStatus === 'declined' ? 'declined' : 'tentative',
              ...(comment ? { comment } : {}),
              proposal,
            })
          }
          loading={respond.isPending}
        />
      ) : null}
    </div>
  )
}

/** «Предложить другое время»: новое начало и конец с комментарием организатору. */
function ProposeDialog({
  record,
  onClose,
  onSend,
  loading,
}: {
  record: EventRecord
  onClose: () => void
  onSend: (
    proposal: { startsAt: string; endsAt: string; recurrenceId: string | null },
    comment: string,
  ) => void
  loading: boolean
}) {
  const t = useT()
  const format = useCalendarFormat()
  const tz = format.timezone
  const ids = { date: useId(), start: useId(), end: useId(), comment: useId() }
  const startsAt = Date.parse(record.occurrence?.startsAt ?? record.startsAt)
  const endsAt = Date.parse(record.occurrence?.endsAt ?? record.endsAt)
  const from = wallOf(startsAt, tz)
  const [date, setDate] = useState(from.date)
  const [start, setStart] = useState(clockText(from.minute))
  const [end, setEnd] = useState(clockText(wallOf(endsAt, tz).minute))
  const [comment, setComment] = useState('')
  const startMs = instantAt(date, clockMinutes(start), tz)
  const endMs = instantAt(date, clockMinutes(end), tz)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="sm"
        title={t('calendar.respond.proposalTitle')}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={endMs <= startMs}
              loading={loading}
              onClick={() =>
                onSend(
                  {
                    startsAt: new Date(startMs).toISOString(),
                    endsAt: new Date(endMs).toISOString(),
                    recurrenceId: record.occurrence?.recurrenceId ?? null,
                  },
                  comment.trim(),
                )
              }
            >
              {t('calendar.respond.send')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label={t('calendar.event.date')} htmlFor={ids.date}>
            <Input
              id={ids.date}
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('calendar.event.start')} htmlFor={ids.start}>
              <Input
                id={ids.start}
                type="time"
                value={start}
                onChange={(event) => setStart(event.target.value)}
              />
            </Field>
            <Field label={t('calendar.event.end')} htmlFor={ids.end}>
              <Input
                id={ids.end}
                type="time"
                value={end}
                onChange={(event) => setEnd(event.target.value)}
              />
            </Field>
          </div>
          <Field label={t('calendar.respond.comment')} htmlFor={ids.comment}>
            <Textarea
              id={ids.comment}
              rows={2}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
