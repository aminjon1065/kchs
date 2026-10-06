import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'

/**
 * События: Модуль «Встречи» (11-communications-meetings.md §3–4). Домены `meeting`, `call`, `recording`, `transcript`, `protocol` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const MEETINGS_EVENTS = {
  // ── meetings (11-communications-meetings.md §3, ADR-0089) ──────────────────
  /** Встреча заведена: звонок из беседы или встреча события календаря. */
  'meeting.scheduled': z.object({
    kind: z.string(),
    eventId: Uuid.nullable(),
    conversationId: Uuid.nullable(),
    participantIds: z.array(Uuid),
  }),
  /** Первый участник вошёл в комнату. */
  'meeting.started': z.object({ kind: z.string(), roomName: z.string() }),
  'meeting.participant_joined': z.object({ userId: Uuid, role: z.string() }),
  'meeting.participant_left': z.object({ userId: Uuid }),
  /** Организатор назначил или снял секретаря — он правит протокол (ADR-0137). */
  'meeting.secretary_changed': z.object({
    secretaryId: Uuid.nullable(),
    previousId: Uuid.nullable(),
  }),
  /**
   * Гость по ссылке просится в комнату (ADR-0091, ADR-0193): открытой комнате встречи — новая
   * заявка, ведущему — сообщение, где бы он ни был. Сама заявка живёт в Redis; `name` — имя,
   * которое гость назвал себе сам.
   */
  'meeting.guest_waiting': z.object({
    meetingId: Uuid,
    requestId: Uuid,
    name: z.string(),
    organizerId: Uuid.nullable(),
  }),
  /** Встреча завершена: вручную, последним вышедшим или отменой события. */
  'meeting.ended': z.object({
    reason: z.enum(['manual', 'empty', 'cancelled']),
    durationSeconds: z.number().int().nullable(),
  }),
  // ── запись и расшифровка встречи (ADR-0092); объект события — запись ──────
  /** Запись включена: индикатор всем участникам комнаты. */
  'recording.started': z.object({ meetingId: Uuid, startedBy: Uuid.nullable() }),
  /** Запись остановлена — медиасервер ещё докладывает файл. */
  'recording.stopped': z.object({ meetingId: Uuid, reason: z.enum(['manual', 'meeting_ended']) }),
  /** Файл записи в реестре: длительность, размер и объект файла. */
  'recording.ready': z.object({
    meetingId: Uuid,
    fileId: Uuid,
    durationSeconds: z.number().int().nullable(),
    sizeBytes: z.number().int().nullable(),
  }),
  'recording.failed': z.object({ meetingId: Uuid, error: z.string() }),
  /** Запись закреплена от удаления по сроку хранения или откреплена (N29, ADR-0138). */
  'recording.pinned': z.object({ meetingId: Uuid, pinned: z.boolean() }),
  /** Организатора предупредили: запись удалится по сроку хранения. */
  'recording.retention_warned': z.object({ meetingId: Uuid, expiresAt: Timestamp }),
  /** Запись удалена по сроку хранения вместе с файлом и расшифровкой. */
  'recording.expired': z.object({ meetingId: Uuid, fileId: Uuid.nullable() }),
  /** Расшифровка готова: сегменты с таймкодами привязаны к записи. */
  'transcript.ready': z.object({
    meetingId: Uuid,
    recordingId: Uuid,
    language: z.string().nullable(),
    segments: z.number().int(),
  }),
  'transcript.failed': z.object({
    meetingId: Uuid,
    recordingId: Uuid,
    /** `unavailable` — модель распознавания не настроена, функция выключена. */
    reason: z.enum(['unavailable', 'failed']),
    error: z.string().nullable(),
  }),
  /**
   * Расшифровку поправили вручную (ADR-0162): текст фразы (`segment` — её
   * номер) или сопоставление говорящего (`label` → `userId`).
   */
  'transcript.edited': z.object({
    meetingId: Uuid,
    recordingId: Uuid,
    change: z.enum(['segment', 'speaker']),
    segment: z.number().int().nullable().default(null),
    label: z.string().nullable().default(null),
    userId: Uuid.nullable().default(null),
  }),

  // ── протокол встречи (11-communications-meetings.md §4, ADR-0093) ─────────
  /** Совместная правка протокола записана: блоки или резюме изменились. */
  'protocol.updated': z.object({ meetingId: Uuid, changed: z.array(z.string()) }),
  /** ИИ дописал в протокол резюме, решения и предложенные поручения. */
  'protocol.drafted': z.object({
    meetingId: Uuid,
    decisions: z.number().int(),
    instructions: z.number().int(),
    usedTranscript: z.boolean(),
  }),
  /** Протокол подтверждён организатором: поручения созданы (`taskIds`). */
  'protocol.confirmed': z.object({
    meetingId: Uuid,
    decisions: z.number().int(),
    taskIds: z.array(Uuid),
  }),
  /** Протокол зарегистрирован документом: дальше — маршрут документа (ADR-0083). */
  'protocol.registered': z.object({ meetingId: Uuid, documentId: Uuid, typeId: Uuid }),
  /** Заказана печатная форма протокола для документа регистрации (N32, ADR-0137). */
  'protocol.print_requested': z.object({ meetingId: Uuid, documentId: Uuid, renderId: Uuid }),
  /** Печатная форма собрана и стала первой версией документа или сборка не удалась. */
  'protocol.printed': z.object({
    meetingId: Uuid,
    documentId: Uuid.nullable(),
    status: z.enum(['ready', 'failed']),
    fileId: Uuid.nullable(),
  }),

  /** Звонок поднят — приглашённым показывается входящий (ADR-0089). */
  'call.incoming': z.object({
    meetingId: Uuid,
    callerId: Uuid.nullable(),
    conversationId: Uuid.nullable(),
    userIds: z.array(Uuid),
  }),
  /** Приглашённый отклонил входящий звонок (ADR-0091): звонящему — сообщение (ADR-0193). */
  'call.declined': z.object({ meetingId: Uuid, userId: Uuid, callerId: Uuid.nullable() }),
} as const satisfies Record<string, z.ZodType>
