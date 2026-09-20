import type { RecordingRecord, TranscriptRecord } from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/**
 * Запись встречи и её расшифровка (ADR-0092). Ключи объектные
 * (`['object', id, …]`) — их сбрасывает realtime по `object.updated`.
 */
export const recordingKeys = {
  recording: (id: string) => ['object', id, 'recording'] as const,
  transcript: (id: string) => ['object', id, 'transcript'] as const,
  playback: (fileId: string) => ['object', fileId, 'playback'] as const,
}

/** Пока медиасервер докладывает файл, карточка опрашивается. */
const PENDING = new Set(['starting', 'active', 'processing'])

export const recordingQuery = (id: string) =>
  queryOptions({
    queryKey: recordingKeys.recording(id),
    queryFn: () => http.get<RecordingRecord>(`/recordings/${id}`),
    refetchInterval: (query) =>
      query.state.data && PENDING.has(query.state.data.status) ? 5000 : false,
  })

const TRANSCRIPT_PENDING = new Set(['queued', 'running'])

export const transcriptQuery = (id: string, enabled: boolean) =>
  queryOptions({
    queryKey: recordingKeys.transcript(id),
    queryFn: () => http.get<TranscriptRecord>(`/recordings/${id}/transcript`),
    enabled,
    refetchInterval: (query) =>
      query.state.data && TRANSCRIPT_PENDING.has(query.state.data.status) ? 5000 : false,
  })

/**
 * Ссылка на воспроизведение — подписанная и живёт 15 минут, поэтому
 * обновляется заранее: плеер восстанавливает позицию сам.
 */
export const playbackQuery = (fileId: string | null) =>
  queryOptions({
    queryKey: recordingKeys.playback(fileId ?? 'none'),
    queryFn: () =>
      http.get<{ url: string; name: string }>(`/files/${fileId}/download`, {
        query: { inline: true },
      }),
    enabled: Boolean(fileId),
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  })
