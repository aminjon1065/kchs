import { bigint, index, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, jsonbArray, jsonbObject, tsCol, updatedAt } from './_shared.js'
import { users } from './identity.js'
import { objects } from './kernel.js'

/**
 * Встречи и звонки (11-communications-meetings.md §3, ADR-0089). Название,
 * пространство, владелец и жизненный цикл — в реестре `objects`; здесь —
 * комната медиасервера, связь с событием календаря и беседой, состояние.
 */
export const meetings = pgTable(
  'meetings',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    /** `call` — звонок из беседы, `scheduled` — встреча по расписанию. */
    kind: text('kind').notNull(),
    status: text('status').notNull().default('planned'),
    /** Комната медиасервера: уникальна и не меняется за время жизни встречи. */
    roomName: text('room_name').notNull().unique(),
    /** Событие календаря (обратная ссылка `events.meeting_id`) — без внешнего ключа: модули не смотрят в чужие таблицы. */
    eventId: uuid('event_id'),
    /** Беседа, из которой подняли звонок. */
    conversationId: uuid('conversation_id'),
    organizerId: uuid('organizer_id').references(() => users.id, { onDelete: 'set null' }),
    /** Плановое время встречи по расписанию — из события календаря. */
    startsAt: tsCol('starts_at'),
    endsAt: tsCol('ends_at'),
    startedAt: tsCol('started_at'),
    endedAt: tsCol('ended_at'),
    settings: jsonbObject('settings'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('meetings_status_idx').on(t.status, t.startsAt),
    index('meetings_event_idx').on(t.eventId),
    index('meetings_conversation_idx').on(t.conversationId),
  ],
)

/**
 * Участники встречи: кого пригласили и кто сейчас в комнате. Гости по ссылке
 * пользователями системы не являются и здесь не хранятся (ADR-0089).
 */
export const meetingParticipants = pgTable(
  'meeting_participants',
  {
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('participant'),
    joinedAt: tsCol('joined_at'),
    leftAt: tsCol('left_at'),
  },
  (t) => [
    primaryKey({ columns: [t.meetingId, t.userId] }),
    index('meeting_participants_user_idx').on(t.userId),
  ],
)

/**
 * Запись встречи (05-data-model.md §Коммуникации, ADR-0092): объект реестра
 * `recording` — ребёнок встречи, поэтому её видит тот, кто видит встречу.
 * Медиафайл — обычный файл реестра (`file_id`), прикреплённый к записи;
 * `egress_id` и `storage_key` — координаты задания медиасервера и его файла.
 */
export const recordings = pgTable(
  'recordings',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    /** `starting` → `active` → `processing` → `ready`; `failed` — сбой медиасервера. */
    status: text('status').notNull().default('starting'),
    /** Задание Egress: по нему находится запись, когда приходит вебхук. */
    egressId: text('egress_id').unique(),
    /** Ключ файла в бакете файлов — выдаётся заранее, туда пишет медиасервер. */
    storageKey: text('storage_key').notNull(),
    /** Файл реестра с записью — появляется, когда медиасервер её доложил. */
    fileId: uuid('file_id'),
    durationS: integer('duration_s'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** `off` | `queued` | `running` | `ready` | `unavailable` | `failed`. */
    transcriptStatus: text('transcript_status').notNull().default('off'),
    error: text('error'),
    startedBy: uuid('started_by').references(() => users.id, { onDelete: 'set null' }),
    startedAt: tsCol('started_at'),
    endedAt: tsCol('ended_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('recordings_meeting_idx').on(t.meetingId, t.createdAt),
    index('recordings_status_idx').on(t.status),
  ],
)

/**
 * Расшифровка записи: сегменты с таймкодами (и спикерами, если диаризация
 * доступна) — клик по фразе перематывает плеер. `summary` заполнит черновик
 * протокола следующей историей.
 */
export const transcripts = pgTable(
  'transcripts',
  {
    id: uuid('id').primaryKey(),
    recordingId: uuid('recording_id')
      .notNull()
      .unique()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    language: text('language'),
    model: text('model'),
    durationS: integer('duration_s'),
    segments: jsonbArray<{ start: number; end: number; text: string; speaker: string | null }>(
      'segments',
    ),
    summary: jsonbObject('summary'),
    createdAt: createdAt(),
  },
  (t) => [index('transcripts_recording_idx').on(t.recordingId)],
)

/**
 * Протокол встречи (11-communications-meetings.md §4, ADR-0093): объект
 * `protocol` — дочерний объекту встречи. Тело ведут совместно (`yjs.documents`),
 * здесь — JSON-снимок блоков, который пишет сервер совместной правки, и итоги:
 * подтверждение, созданные поручения и документ регистрации.
 */
export const protocols = pgTable(
  'protocols',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    /** `agenda` — повестка, `draft` — протокол правится, `confirmed` — подтверждён. */
    status: text('status').notNull().default('agenda'),
    blocks: jsonbArray('blocks'),
    /** Резюме встречи из черновика ИИ. */
    summary: text('summary'),
    /** Поручения по блокам протокола: `{"<blockId>": "<taskId>"}`. */
    instructions: jsonbObject<Record<string, string>>('instructions'),
    /** Документ, которым зарегистрирован протокол (объект реестра). */
    documentId: uuid('document_id').references(() => objects.id, { onDelete: 'set null' }),
    confirmedAt: tsCol('confirmed_at'),
    confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    registeredAt: tsCol('registered_at'),
    /** Ознакомление участников запрошено (учёт ведёт ядро, ADR-0084). */
    acknowledgmentAt: tsCol('acknowledgment_at'),
    /**
     * Печатная форма протокола — первая версия документа (N32, ADR-0137):
     * заказанный рендер, состояние (`pending` | `ready` | `failed`) и готовый PDF.
     */
    printRenderId: uuid('print_render_id'),
    printStatus: text('print_status'),
    printFileId: uuid('print_file_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('protocols_meeting_idx').on(t.meetingId),
    index('protocols_document_idx').on(t.documentId),
  ],
)
