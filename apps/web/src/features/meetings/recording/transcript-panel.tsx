import type { TranscriptRecord, TranscriptSegment } from '@kchs/contracts'
import { Button, Callout, cn, EmptyState, ScrollArea, SearchInput, Spinner } from '@kchs/ui'
import { Download, FileText } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useT } from '~/app/i18n.js'

/** Таймкод фразы: мм:сс или ч:мм:сс для долгих встреч. */
export function timecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes)
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(rest).padStart(2, '0')}`
}

/** Расшифровка целиком — для выгрузки текстом: таймкод, спикер, фраза. */
export function transcriptText(segments: readonly TranscriptSegment[]): string {
  return segments
    .map((segment) =>
      [`[${timecode(segment.start)}]`, segment.speaker, segment.text].filter(Boolean).join(' '),
    )
    .join('\n')
}

/**
 * Расшифровка рядом с плеером (11-communications-meetings.md §4): клик по фразе
 * перематывает запись, поиск оставляет только подходящие фразы, выгрузка
 * отдаёт текст файлом.
 */
export function TranscriptPanel({
  transcript,
  currentTime,
  onSeek,
  onExport,
}: {
  transcript: TranscriptRecord | undefined
  currentTime: number
  onSeek: (seconds: number) => void
  onExport: () => void
}) {
  const t = useT()
  const [search, setSearch] = useState('')

  const segments = useMemo(() => {
    const all = transcript?.segments ?? []
    const needle = search.trim().toLocaleLowerCase()
    if (!needle) return all
    return all.filter((segment) => segment.text.toLocaleLowerCase().includes(needle))
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
  if (status === 'off' || (transcript?.segments.length ?? 0) === 0) {
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
      <div className="flex items-center gap-2 border-b border-line p-2">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          onClear={() => setSearch('')}
          placeholder={t('meetings.recording.transcript.search')}
          className="flex-1"
        />
        <Button
          size="sm"
          variant="ghost"
          icon={<Download className="size-3.5" aria-hidden />}
          onClick={onExport}
        >
          {t('meetings.recording.transcript.export')}
        </Button>
      </div>
      {segments.length === 0 ? (
        <EmptyState compact title={t('meetings.recording.transcript.nothingFound')} />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="flex flex-col gap-0.5 p-2">
            {segments.map((segment) => {
              const active = currentTime >= segment.start && currentTime < segment.end
              return (
                <li key={`${segment.start}-${segment.end}`}>
                  <button
                    type="button"
                    onClick={() => onSeek(segment.start)}
                    className={cn(
                      'flex w-full gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                      'hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none',
                      active && 'bg-surface-3',
                    )}
                  >
                    <span className="shrink-0 pt-0.5 font-mono text-xs text-fg-muted tabular-nums">
                      {timecode(segment.start)}
                    </span>
                    <span className="min-w-0 flex-1 text-fg">
                      {segment.speaker ? (
                        <span className="mr-1 font-medium text-fg-muted">{segment.speaker}</span>
                      ) : null}
                      {segment.text}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      )}
    </div>
  )
}
