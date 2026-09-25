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

/**
 * Срок хранения записей встреч (N29, ADR-0138): по умолчанию 6 месяцев от
 * окончания записи; за неделю до удаления организатор получает предупреждение и
 * может закрепить запись. Записи, связанные с протоколом или документом (дело),
 * и закреплённые не удаляются.
 */
export const RECORDING_RETENTION_DEFAULT_MONTHS = 6
export const RECORDING_RETENTION_WARNING_DAYS = 7

export const MeetingSettings = z.object({
  /** Срок хранения записей встреч, месяцев; 0 — хранить бессрочно. */
  recordingRetentionMonths: z.number().int().min(0).max(120),
})
export type MeetingSettings = z.infer<typeof MeetingSettings>

/** Закрепить запись — срок хранения на неё не действует; открепить — снова действует. */
export const RecordingPinInput = z.object({ pinned: z.boolean() })
export type RecordingPinInput = z.infer<typeof RecordingPinInput>

export const RecordingPermissions = z.object({
  /** Остановить запись: способность `meetings.record` и право вести встречу. */
  stop: z.boolean(),
  /** Закрепить или открепить запись от удаления по сроку — организатор (N29). */
  pin: z.boolean(),
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
  /** Закреплена от удаления по сроку хранения (N29). */
  pinnedAt: Timestamp.nullable(),
  /**
   * Когда запись удалится по сроку хранения; null — не удалится: закреплена,
   * связана с протоколом или документом, срок выключен или запись ещё идёт.
   */
  expiresAt: Timestamp.nullable(),
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

/** Предел текста одной фразы при исправлении вручную (ADR-0162). */
export const TRANSCRIPT_SEGMENT_MAX_TEXT = 4000

/**
 * Фраза в выдаче: исправленная вручную помечена, `original` — текст
 * распознавания до первой правки (ADR-0162).
 */
export const TranscriptRecordSegment = TranscriptSegment.extend({
  edited: z.boolean().default(false),
  original: z.string().nullable().default(null),
})
export type TranscriptRecordSegment = z.infer<typeof TranscriptRecordSegment>

/**
 * Говорящий расшифровки: метка диаризации («Говорящий 1») и участник встречи,
 * с которым её сопоставили; сопоставление хранится при расшифровке (ADR-0162).
 */
export const TranscriptSpeaker = z.object({
  label: z.string(),
  user: UserRef.nullable(),
})
export type TranscriptSpeaker = z.infer<typeof TranscriptSpeaker>

export const TranscriptRecord = z.object({
  recordingId: Uuid,
  status: TranscriptStatus,
  language: z.string().nullable(),
  model: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  segments: z.array(TranscriptRecordSegment),
  /** Метки говорящих в порядке первого появления — с сопоставленными участниками. */
  speakers: z.array(TranscriptSpeaker).default([]),
  error: z.string().nullable(),
  createdAt: Timestamp.nullable(),
  /** Последнее исправление фразы или говорящего. */
  editedAt: Timestamp.nullable().default(null),
  /** Исправлять фразы и сопоставлять говорящих — право `edit` на записи. */
  can: z.object({ edit: z.boolean() }).default({ edit: false }),
})
export type TranscriptRecord = z.infer<typeof TranscriptRecord>

/** Исправление текста фразы; таймкоды и говорящий не меняются. */
export const TranscriptSegmentEditInput = z.object({
  text: z.string().trim().min(1).max(TRANSCRIPT_SEGMENT_MAX_TEXT),
})
export type TranscriptSegmentEditInput = z.infer<typeof TranscriptSegmentEditInput>

/** Сопоставить метку говорящего с участником встречи или снять сопоставление. */
export const TranscriptSpeakerInput = z.object({
  label: z.string().min(1).max(100),
  userId: Uuid.nullable(),
})
export type TranscriptSpeakerInput = z.infer<typeof TranscriptSpeakerInput>

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
