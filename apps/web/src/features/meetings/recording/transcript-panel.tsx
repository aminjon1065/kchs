import type { TranscriptRecord, TranscriptSegment, UserRef } from '@kchs/contracts'
import {
  Button,
  Callout,
  cn,
  EmptyState,
  IconButton,
  ScrollArea,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Download, FileText, Pencil, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { recordingKeys } from './queries.js'

/** Значение выбора «говорящий не сопоставлен» — у Select не бывает пустого значения. */
const NOBODY = '__nobody'

/** Таймкод фразы: мм:сс или ч:мм:сс для долгих встреч. */
export function timecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes)
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(rest).padStart(2, '0')}`
}

/** Имена сопоставленных говорящих (ADR-0162): метка → имя участника. */
export function speakerNames(transcript: TranscriptRecord | undefined): Map<string, string> {
  return new Map(
    (transcript?.speakers ?? []).flatMap((speaker) =>
      speaker.user ? [[speaker.label, speaker.user.displayName] as const] : [],
    ),
  )
}

/** Расшифровка целиком — для выгрузки текстом: таймкод, говорящий, фраза. */
export function transcriptText(
  segments: readonly TranscriptSegment[],
  names: ReadonlyMap<string, string> = new Map(),
): string {
  return segments
    .map((segment) =>
      [
        `[${timecode(segment.start)}]`,
        segment.speaker ? (names.get(segment.speaker) ?? segment.speaker) : null,
        segment.text,
      ]
        .filter(Boolean)
        .join(' '),
    )
    .join('\n')
}

/**
 * Расшифровка рядом с плеером (11-communications-meetings.md §4): клик по фразе
 * перематывает запись, поиск оставляет только подходящие фразы, выгрузка
 * отдаёт текст файлом. С правом правки (ADR-0162) фразу можно исправить, а
 * метку говорящего — сопоставить с участником встречи.
 */
export function TranscriptPanel({
  transcript,
  participants,
  currentTime,
  onSeek,
  onExport,
}: {
  transcript: TranscriptRecord | undefined
  /** Участники встречи — кого можно указать говорящим. */
  participants: UserRef[]
  currentTime: number
  onSeek: (seconds: number) => void
  onExport: () => void
}) {
  const t = useT()
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<number | null>(null)
  const [speakersOpen, setSpeakersOpen] = useState(false)
  const names = useMemo(() => speakerNames(transcript), [transcript])
  const canEdit = transcript?.can.edit ?? false

  // Номер фразы сохраняется и при поиске: правка идёт по её месту в расшифровке
  const segments = useMemo(() => {
    const all = (transcript?.segments ?? []).map((segment, index) => ({ segment, index }))
    const needle = search.trim().toLocaleLowerCase()
    if (!needle) return all
    return all.filter(({ segment }) => segment.text.toLocaleLowerCase().includes(needle))
  }, [transcript, search])

  const status = transcript?.status ?? 'off'
  if (status === 'queued' || status === 'running') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Spinner />
        <p className="text-sm text-fg-muted">{t('meetings.recording.transcript.pending')}</p>
      </div>
    )
  }
  if (status === 'unavailable') {
    return (
      <div className="p-4">
        <Callout tone="info" title={t('meetings.recording.transcript.unavailable')}>
          {t('meetings.recording.transcript.unavailableHint')}
        </Callout>
      </div>
    )
  }
  if (status === 'failed') {
    return (
      <div className="p-4">
        <Callout tone="danger" title={t('meetings.recording.transcript.failed')}>
          {transcript?.error ?? t('meetings.recording.transcript.failedHint')}
        </Callout>
      </div>
    )
  }
  if (!transcript || status === 'off' || transcript.segments.length === 0) {
    return (
      <EmptyState
        compact
        icon={<FileText className="size-5" aria-hidden />}
        title={t('meetings.recording.transcript.empty')}
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-2">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          onClear={() => setSearch('')}
          placeholder={t('meetings.recording.transcript.search')}
          className="min-w-40 flex-1"
        />
        {canEdit && transcript.speakers.length > 0 ? (
          <Button
            size="sm"
            variant={speakersOpen ? 'secondary' : 'ghost'}
            icon={<Users className="size-3.5" aria-hidden />}
            aria-expanded={speakersOpen}
            onClick={() => setSpeakersOpen((open) => !open)}
          >
            {t('meetings.recording.transcript.speakers')}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          icon={<Download className="size-3.5" aria-hidden />}
          onClick={onExport}
        >
          {t('meetings.recording.transcript.export')}
        </Button>
      </div>
      {speakersOpen && canEdit ? (
        <SpeakerMapping transcript={transcript} participants={participants} />
      ) : null}
      {segments.length === 0 ? (
        <EmptyState compact title={t('meetings.recording.transcript.nothingFound')} />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="flex flex-col gap-0.5 p-2">
            {segments.map(({ segment, index }) => {
              const active = currentTime >= segment.start && currentTime < segment.end
              const speaker = segment.speaker
                ? (names.get(segment.speaker) ?? segment.speaker)
                : null
              if (editing === index) {
                return (
                  <li key={`${segment.start}-${segment.end}`}>
                    <SegmentEditor
                      recordingId={transcript.recordingId}
                      index={index}
                      text={segment.text}
                      onDone={() => setEditing(null)}
                    />
                  </li>
                )
              }
              return (
                <li
                  key={`${segment.start}-${segment.end}`}
                  className="group flex items-start gap-1"
                >
                  <button
                    type="button"
                    onClick={() => onSeek(segment.start)}
                    className={cn(
                      'flex min-w-0 flex-1 gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                      'hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none',
                      active && 'bg-surface-3',
                    )}
                  >
                    <span className="shrink-0 pt-0.5 font-mono text-xs text-fg-muted tabular-nums">
                      {timecode(segment.start)}
                    </span>
                    <span className="min-w-0 flex-1 text-fg">
                      {speaker ? (
                        <span className="mr-1 font-medium text-fg-muted">{speaker}</span>
                      ) : null}
                      {segment.text}
                      {segment.edited ? (
                        <span
                          className="ml-1 text-2xs text-fg-muted"
                          title={
                            segment.original
                              ? t('meetings.recording.transcript.originalText', {
                                  text: segment.original,
                                })
                              : undefined
                          }
                        >
                          {t('meetings.recording.transcript.edited')}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  {canEdit ? (
                    <IconButton
                      size="sm"
                      label={t('meetings.recording.transcript.editSegment', {
                        time: timecode(segment.start),
                      })}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                      onClick={() => setEditing(index)}
                    >
                      <Pencil className="size-3.5" />
                    </IconButton>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      )}
    </div>
  )
}

/** Исправление текста фразы на месте: Esc — отмена, ⌘/Ctrl+Enter — сохранить. */
function SegmentEditor({
  recordingId,
  index,
  text,
  onDone,
}: {
  recordingId: string
  index: number
  text: string
  onDone: () => void
}) {
  const t = useT()
  const client = useQueryClient()
  const [draft, setDraft] = useState(text)
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: () =>
      http.patch<TranscriptRecord>(`/recordings/${recordingId}/transcript/segments/${index}`, {
        text: draft.trim(),
      }),
    onSuccess: (next) => {
      client.setQueryData(recordingKeys.transcript(recordingId), next)
      onDone()
    },
    onError: (failure) =>
      setError(failure instanceof ApiError ? failure.message : t('errors.unknown')),
  })
  return (
    <form
      className="flex flex-col gap-1.5 rounded-md bg-surface-2 p-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (draft.trim()) save.mutate()
      }}
    >
      <Textarea
        value={draft}
        autoFocus
        autoGrow
        aria-label={t('meetings.recording.transcript.segmentText')}
        invalid={Boolean(error)}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onDone()
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            if (draft.trim()) save.mutate()
          }
        }}
      />
      {error ? <p className="text-2xs text-danger">{error}</p> : null}
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          loading={save.isPending}
          disabled={!draft.trim() || draft.trim() === text}
        >
          {t('common.actions.save')}
        </Button>
      </div>
    </form>
  )
}

/**
 * Говорящие расшифровки: метку диаризации («Говорящий 1») сопоставляют с
 * участником встречи; имя затем видно во фразах, выгрузке и черновике протокола.
 */
function SpeakerMapping({
  transcript,
  participants,
}: {
  transcript: TranscriptRecord
  participants: UserRef[]
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const assign = useMutation({
    mutationFn: (input: { label: string; userId: string | null }) =>
      http.put<TranscriptRecord>(
        `/recordings/${transcript.recordingId}/transcript/speakers`,
        input,
      ),
    onSuccess: (next) =>
      client.setQueryData(recordingKeys.transcript(transcript.recordingId), next),
    onError: (failure) =>
      toast.error(failure instanceof ApiError ? failure.message : t('errors.unknown')),
  })
  return (
    <section
      aria-label={t('meetings.recording.transcript.speakers')}
      className="flex flex-col gap-2 border-b border-line bg-surface-2 p-2"
    >
      <p className="text-2xs text-fg-muted">{t('meetings.recording.transcript.speakersHint')}</p>
      <ul className="flex flex-col gap-1.5">
        {transcript.speakers.map((speaker) => (
          <li key={speaker.label} className="flex items-center gap-2">
            <span className="w-28 shrink-0 truncate text-sm text-fg" title={speaker.label}>
              {speaker.label}
            </span>
            <Select
              value={speaker.user?.id ?? NOBODY}
              onValueChange={(value) =>
                assign.mutate({ label: speaker.label, userId: value === NOBODY ? null : value })
              }
            >
              <SelectTrigger
                className="h-8 flex-1"
                aria-label={t('meetings.recording.transcript.speakerOf', { label: speaker.label })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NOBODY}>
                  {t('meetings.recording.transcript.speakerUnknown')}
                </SelectItem>
                {participants.map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    {user.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </li>
        ))}
      </ul>
    </section>
  )
}
