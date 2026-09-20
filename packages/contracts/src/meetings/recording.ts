import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { Timestamp, Uuid } from '../common/primitives.js'

/**
 * Запись встречи и её расшифровка (11-communications-meetings.md §3–§4,
 * ADR-0092). Запись — объект реестра `recording` внутри встречи: её видит тот,
 * кто видит встречу. Медиафайл — обычный файл реестра, прикреплённый к записи;
 * расшифровка — строки модуля встреч, привязанные к таймкодам файла.
 */

/**
 * `starting` — запрос ушёл медиасерверу; `active` — идёт; `processing` —
 * остановлена, медиасервер докладывает файл; `ready` — файл в реестре;
 * `failed` — медиасервер не справился (причина — в `error`).
 */
export const RECORDING_STATUSES = ['starting', 'active', 'processing', 'ready', 'failed'] as const
export const RecordingStatus = z.enum(RECORDING_STATUSES)
export type RecordingStatus = z.infer<typeof RecordingStatus>

/** Запись идёт — этот статус видят все участники комнаты. */
export const RECORDING_LIVE_STATUSES = ['starting', 'active'] as const

/**
 * `off` — расшифровка не заказывалась; `queued`/`running` — задание движка;
 * `ready` — сегменты есть; `unavailable` — модель распознавания не настроена;
 * `failed` — движок не справился.
 */
export const TRANSCRIPT_STATUSES = [
  'off',
  'queued',
  'running',
  'ready',
  'unavailable',
  'failed',
] as const
export const TranscriptStatus = z.enum(TRANSCRIPT_STATUSES)
export type TranscriptStatus = z.infer<typeof TranscriptStatus>

/** Языки распознавания речи (11-communications-meetings.md §4). */
export const TRANSCRIPT_LANGUAGES = ['ru', 'tg', 'en'] as const
export const TranscriptLanguage = z.enum(TRANSCRIPT_LANGUAGES)
export type TranscriptLanguage = z.infer<typeof TranscriptLanguage>

/** Предел сегментов одной расшифровки: длинная встреча не раздувает строку. */
export const TRANSCRIPT_MAX_SEGMENTS = 20_000

/** Формат записи: composite-дорожка комнаты одним файлом. */
export const RECORDING_MIME = 'video/mp4'

/** Задание расшифровки: очередь движка и имя обработчика (ADR-0035). */
export const TRANSCRIBE_JOB = { queue: 'media', name: 'media.transcribe' } as const

export const RecordingPermissions = z.object({
  /** Остановить запись: способность `meetings.record` и право вести встречу. */
  stop: z.boolean(),
})
export type RecordingPermissions = z.infer<typeof RecordingPermissions>

export const RecordingRecord = z.object({
  id: Uuid,
  meetingId: Uuid,
  title: z.string(),
  status: RecordingStatus,
  /** Кто включил запись. */
  startedBy: UserRef.nullable(),
  startedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
  durationSeconds: z.number().int().nullable(),
  sizeBytes: z.number().int().nullable(),
  /** Файл реестра с записью — появляется, когда медиасервер её доложил. */
  fileId: Uuid.nullable(),
  fileName: z.string().nullable(),
  transcriptStatus: TranscriptStatus,
  error: z.string().nullable(),
  can: RecordingPermissions,
  createdAt: Timestamp,
})
export type RecordingRecord = z.infer<typeof RecordingRecord>

export const RecordingList = z.object({ items: z.array(RecordingRecord) })
export type RecordingList = z.infer<typeof RecordingList>

/** Ссылка на воспроизведение: подписанная, живёт недолго — плеер обновляет её. */
export const RecordingPlayback = z.object({
  url: z.string(),
  mime: z.string(),
  expiresAt: Timestamp,
})
export type RecordingPlayback = z.infer<typeof RecordingPlayback>

/**
 * Фраза расшифровки: секунды от начала записи, поэтому клик по фразе
 * перематывает плеер. Спикер известен не всегда — диаризация необязательна.
 */
export const TranscriptSegment = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  text: z.string(),
  speaker: z.string().nullable().default(null),
})
export type TranscriptSegment = z.infer<typeof TranscriptSegment>

export const TranscriptRecord = z.object({
  recordingId: Uuid,
  status: TranscriptStatus,
  language: z.string().nullable(),
  model: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  segments: z.array(TranscriptSegment),
  error: z.string().nullable(),
  createdAt: Timestamp.nullable(),
})
export type TranscriptRecord = z.infer<typeof TranscriptRecord>

/**
 * Итог задания `media:media.transcribe` (движок → api внутренним маршрутом).
 * `unavailable` — модель распознавания не настроена: функция выключена, это не
 * сбой задания.
 */
export const TranscriptResult = z.object({
  status: z.enum(['ready', 'unavailable', 'failed']),
  language: z.string().max(16).nullable().default(null),
  model: z.string().max(200).nullable().default(null),
  durationSeconds: z.number().nullable().default(null),
  segments: z.array(TranscriptSegment).max(TRANSCRIPT_MAX_SEGMENTS).default([]),
  error: z.string().max(2000).nullable().default(null),
})
export type TranscriptResult = z.infer<typeof TranscriptResult>
