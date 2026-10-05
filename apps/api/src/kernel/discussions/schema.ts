import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, jsonbObject, tsCol, updatedAt } from '../../shared/db/columns.js'
import { users } from '../directory/schema.js'
import { objects } from '../objects/schema.js'

// ─── Обсуждения (единые с чатами) ────────────────────────────────────────────

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** Обсуждение объекта: ровно одна беседа на объект. */
    objectId: uuid('object_id')
      .unique()
      .references(() => objects.id, { onDelete: 'cascade' }),
    privacy: text('privacy').notNull().default('closed'),
    lastMessageAt: tsCol('last_message_at'),
    messageCount: integer('message_count').notNull().default(0),
    settings: jsonbObject('settings'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('conversations_kind_idx').on(t.kind, t.lastMessageAt.desc())],
)

export const conversationMembers = pgTable(
  'conversation_members',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    lastReadMessageId: bigint('last_read_message_id', { mode: 'number' }),
    mutedUntil: tsCol('muted_until'),
    pinned: boolean('pinned').notNull().default(false),
    /** Убрана участником в архив (ADR-0161); у каждого участника — свой. */
    archivedAt: tsCol('archived_at'),
    joinedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    index('conversation_members_user_idx').on(t.userId),
  ],
)

export const messages = pgTable(
  'messages',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    onBehalfOf: uuid('on_behalf_of'),
    kind: text('kind').notNull().default('user'),
    /** Tiptap JSON. */
    body: jsonb('body').$type<Record<string, unknown> | null>(),
    text: text('text').notNull().default(''),
    /** Для системных сообщений: ключ i18n и параметры. */
    systemKey: text('system_key'),
    systemParams: jsonb('system_params').$type<Record<string, unknown> | null>(),
    replyToId: bigint('reply_to_id', { mode: 'number' }),
    threadRootId: bigint('thread_root_id', { mode: 'number' }),
    threadReplyCount: integer('thread_reply_count').notNull().default(0),
    threadLastReplyAt: tsCol('thread_last_reply_at'),
    attachments: jsonb('attachments')
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    mentions: uuid('mentions').array().notNull().default(sql`'{}'::uuid[]`),
    mentionedObjectIds: uuid('mentioned_object_ids').array().notNull().default(sql`'{}'::uuid[]`),
    editedAt: tsCol('edited_at'),
    deletedAt: tsCol('deleted_at'),
    createdAt: createdAt(),
    meta: jsonbObject('meta'),
  },
  (t) => [
    index('messages_conversation_idx').on(t.conversationId, t.id.desc()),
    index('messages_thread_idx').on(t.threadRootId),
    index('messages_mentions_idx').using('gin', t.mentions),
    index('messages_text_trgm').using('gin', sql`${t.text} extensions.gin_trgm_ops`),
  ],
)

export const reactions = pgTable(
  'reactions',
  {
    messageId: bigint('message_id', { mode: 'number' })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
)

export type MessageRow = typeof messages.$inferSelect
