import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  NoAccessState,
  ObjectIcon,
  PanelToolbar,
  Skeleton,
  Spinner,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Download, Video } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { saveLink } from '~/features/documents/print/renders.js'
import { useFileDownload } from '~/features/files/use-file-download.js'
import { ApiError } from '~/shared/api/client.js'
import { playbackQuery, recordingQuery, transcriptQuery } from './queries.js'
import { TranscriptPanel, transcriptText } from './transcript-panel.js'

const TONE = {
  starting: 'warning',
  active: 'danger',
  processing: 'warning',
  ready: 'success',
  failed: 'danger',
} as const

/**
 * Запись встречи во вкладке (11-communications-meetings.md §3–§4, ADR-0092):
 * плеер и расшифровка рядом. Клик по фразе перематывает запись, текущая фраза
 * подсвечивается, расшифровку можно искать и выгрузить текстом. Права — от
 * записи: постороннему вкладка вообще не открывается.
 */
export default function RecordingView({ objectId, tabId }: { objectId: string; tabId: string }) {
  const t = useT()
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const video = useRef<HTMLVideoElement>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const download = useFileDownload()

  const { data: record, isLoading, error, refetch } = useQuery(recordingQuery(objectId))
  const { data: playback } = useQuery(playbackQuery(record?.fileId ?? null))
  const { data: transcript } = useQuery(
    transcriptQuery(objectId, record?.status === 'ready' || record?.transcriptStatus === 'ready'),
  )

  useEffect(() => {
    if (record) setTabTitle(tabId, record.title)
  }, [record, tabId, setTabTitle])

  // Подписанная ссылка живёт 15 минут: при обновлении плеер возвращается на место
  const source = playback?.url
  useEffect(() => {
    const element = video.current
    if (!element || !source) return
    const at = element.currentTime
    if (at > 0) element.currentTime = at
  }, [source])

  const seek = useCallback((seconds: number) => {
    const element = video.current
    if (!element) return
    element.currentTime = seconds
    void element.play().catch(() => undefined)
  }, [])

  const exportText = useCallback(() => {
    if (!transcript || transcript.segments.length === 0) return
    const blob = new Blob([transcriptText(transcript.segments)], {
      type: 'text/plain;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    saveLink({ url, name: `${record?.title ?? 'transcript'}.txt` })
    URL.revokeObjectURL(url)
  }, [transcript, record])

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      return <NoAccessState />
    }
    return (
      <ErrorState
        description={error instanceof ApiError ? error.message : t('errors.unknown')}
        onRetry={() => refetch()}
      />
    )
  }
  if (!record) return <EmptyState title={t('common.states.notFound')} />

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <ObjectIcon type="recording" className="size-4 shrink-0 text-fg-muted" />
            <span className="truncate text-sm font-semibold text-fg">{record.title}</span>
            <Badge tone={TONE[record.status]}>
              {t(`meetings.recording.status.${record.status}`)}
            </Badge>
          </>
        }
        right={
          record.fileId ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Download className="size-3.5" aria-hidden />}
              disabled={download.isPending}
              onClick={() => download.mutate({ fileId: record.fileId as string })}
            >
              {t('meetings.recording.download')}
            </Button>
          ) : null
        }
      />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 flex-1 items-center justify-center bg-surface-2 p-4">
          {record.status === 'ready' && source ? (
            // biome-ignore lint/a11y/useMediaCaption: дорожка субтитров — расшифровка рядом
            <video
              ref={video}
              src={source}
              controls
              preload="metadata"
              className="max-h-full w-full rounded-lg bg-black"
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            >
              {t('meetings.recording.player.unsupported')}
            </video>
          ) : record.status === 'failed' ? (
            <EmptyState
              icon={<Video className="size-5" aria-hidden />}
              title={t('meetings.recording.failed')}
              description={record.error ?? t('meetings.recording.failedHint')}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 text-center">
              <Spinner />
              <p className="text-sm text-fg-muted">
                {t(
                  record.status === 'processing'
                    ? 'meetings.recording.processing'
                    : 'meetings.recording.live',
                )}
              </p>
            </div>
          )}
        </div>
        <aside className="flex min-h-0 w-full flex-col border-line border-t lg:w-96 lg:border-t-0 lg:border-l">
          <TranscriptPanel
            transcript={transcript}
            currentTime={currentTime}
            onSeek={seek}
            onExport={exportText}
          />
        </aside>
      </div>
    </div>
  )
}
