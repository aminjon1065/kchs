import { index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, jsonbObject, tsCol, updatedAt } from './_shared.js'
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
