import { sql } from 'drizzle-orm'
import { bigint, boolean, index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, jsonbObject, tsCol, updatedAt } from './_shared.js'
import { users } from './identity.js'
import { conversations } from './kernel.js'

/**
 * Чаты (11-communications-meetings.md §1, ADR-0090). Сама беседа, участники,
 * сообщения и реакции — таблицы ядра (`conversations`, `conversation_members`,
 * `messages`, `reactions`): обсуждение объекта и чат — одна сущность
 * (02-platform-kernel.md §6). Здесь — то, что есть только у чатов.
 */

/**
 * Надстройка над беседой: ключ личной беседы (детерминированный по паре) и
 * системный ключ канала подразделения (`space:<id>`) — по ним беседа
 * находится повторно, не создаваясь второй раз.
 */
export const chatConversations = pgTable(
  'chat_conversations',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** `<idA>:<idB>` с отсортированной парой — одна личная беседа на двоих. */
    directKey: text('direct_key').unique(),
    /** Канал подразделения: `space:<spaceId>`; создаётся подписчиком `space.created`. */
    systemKey: text('system_key').unique(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('chat_conversations_system_idx').on(t.systemKey)],
)

/** Закреплённые сообщения беседы: шапка ленты, порядок — по времени закрепления. */
export const chatPins = pgTable(
  'chat_pins',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    pinnedBy: uuid('pinned_by').references(() => users.id, { onDelete: 'set null' }),
    pinnedAt: tsCol('pinned_at').notNull().default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.messageId] }),
    index('chat_pins_conversation_idx').on(t.conversationId, t.pinnedAt.desc()),
  ],
)

/**
 * Черновик беседы или треда — интерфейс, а не домен: событий outbox не
 * публикует (как настройки календаря, ADR-0081). `thread_root_id = 0` — лента.
 */
export const chatDrafts = pgTable(
  'chat_drafts',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    threadRootId: bigint('thread_root_id', { mode: 'number' }).notNull().default(0),
    body: jsonbObject('body'),
    text: text('text').notNull().default(''),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId, t.threadRootId] }),
    index('chat_drafts_user_idx').on(t.userId, t.updatedAt.desc()),
  ],
)

/**
 * Присутствие и статус пользователя (11-communications-meetings.md §1):
 * выбранный статус, тихие часы и «не беспокоить» — здесь, «на встрече»
 * выставляет подписчик `meeting.participant_joined`/`left`.
 */
export const userPresence = pgTable(
  'user_presence',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Выбранный пользователем статус: `online` | `away` | `dnd`. */
    status: text('status').notNull().default('online'),
    /** До какого момента держать выбранный статус («не беспокоить час»). */
    statusUntil: tsCol('status_until'),
    /** Тихие часы: `{ enabled, from: 'ЧЧ:ММ', to: 'ЧЧ:ММ' }` в поясе пользователя. */
    quietHours: jsonbObject<{ enabled?: boolean; from?: string; to?: string }>('quiet_hours'),
    /** Пользователь в комнате встречи — статус «на встрече» поверх выбранного. */
    inMeeting: boolean('in_meeting').notNull().default(false),
    /** Последняя активность в приложении: дольше 5 минут — «отошёл». */
    lastSeenAt: tsCol('last_seen_at'),
    updatedAt: updatedAt(),
  },
  (t) => [index('user_presence_seen_idx').on(t.lastSeenAt.desc())],
)
