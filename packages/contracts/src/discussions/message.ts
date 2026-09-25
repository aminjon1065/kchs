import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { Timestamp, Uuid } from '../common/primitives.js'

/** Виды бесед: обсуждение объекта, личная, группа, канал (02-platform-kernel.md §6). */
export const CONVERSATION_KINDS = ['object', 'direct', 'group', 'channel'] as const
export const ConversationKind = z.enum(CONVERSATION_KINDS)
export type ConversationKind = z.infer<typeof ConversationKind>

export const MESSAGE_KINDS = ['user', 'system', 'decision', 'action'] as const

/**
 * Срок, в который автор может изменить или удалить своё сообщение (ADR-0161).
 * Позже переписка становится записью: удалить может только ведущий беседы.
 */
export const MESSAGE_EDIT_WINDOW_HOURS = 24
export const MessageKind = z.enum(MESSAGE_KINDS)
export type MessageKind = z.infer<typeof MessageKind>

/** Тело сообщения — Tiptap JSON; `text` — плоская проекция для поиска и превью. */
export const RichBody = z.object({
  type: z.literal('doc'),
  content: z.array(z.record(z.string(), z.unknown())).default([]),
})
export type RichBody = z.infer<typeof RichBody>

export const MessageAttachment = z.object({
  fileId: Uuid,
  name: z.string(),
  mime: z.string(),
  size: z.number().int(),
  previewUrl: z.string().nullable().optional(),
})

export const Reaction = z.object({
  emoji: z.string().max(16),
  count: z.number().int(),
  users: z.array(Uuid),
  mine: z.boolean(),
})

export const Message = z.object({
  id: z.string(),
  conversationId: Uuid,
  author: UserRef.nullable(),
  onBehalfOf: UserRef.nullable().optional(),
  kind: MessageKind,
  body: RichBody.nullable(),
  text: z.string(),
  /** Для kind=system: ключ i18n и параметры вместо свободного текста. */
  systemKey: z.string().nullable().optional(),
  systemParams: z.record(z.string(), z.unknown()).nullable().optional(),
  replyToId: z.string().nullable(),
  threadRootId: z.string().nullable(),
  threadReplyCount: z.number().int().default(0),
  threadLastReplyAt: Timestamp.nullable().optional(),
  attachments: z.array(MessageAttachment).default([]),
  mentions: z.array(Uuid).default([]),
  mentionedObjectIds: z.array(Uuid).default([]),
  /** Якорь на фрагмент объекта (комментарий к блоку страницы, ADR-0095). */
  anchor: z.string().nullable().default(null),
  reactions: z.array(Reaction).default([]),
  /** Что смотрящий может сделать с сообщением: правка — автор в срок, удаление — ещё и ведущий. */
  can: z.object({ edit: z.boolean(), delete: z.boolean() }).default({ edit: false, delete: false }),
  editedAt: Timestamp.nullable(),
  deletedAt: Timestamp.nullable(),
  createdAt: Timestamp,
})
export type Message = z.infer<typeof Message>

export const Conversation = z.object({
  id: Uuid,
  kind: ConversationKind,
  title: z.string(),
  objectId: Uuid.nullable(),
  spaceId: Uuid.nullable(),
  privacy: z.enum(['open', 'closed']),
  lastMessageAt: Timestamp.nullable(),
  unreadCount: z.number().int().default(0),
  memberCount: z.number().int().default(0),
  muted: z.boolean().default(false),
})
export type Conversation = z.infer<typeof Conversation>

export const MessagePostInput = z.object({
  body: RichBody,
  text: z.string().max(20000),
  replyToId: z.string().nullable().optional(),
  threadRootId: z.string().nullable().optional(),
  attachments: z.array(z.object({ fileId: Uuid })).default([]),
  mentions: z.array(Uuid).default([]),
  mentionedObjectIds: z.array(Uuid).default([]),
  /**
   * Якорь на фрагмент объекта: комментарий относится не ко всему объекту, а к
   * его части. Значение задаёт тип объекта — у страницы базы знаний это
   * идентификатор блока (ADR-0095).
   */
  anchor: z.string().max(64).nullable().optional(),
  idempotencyKey: z.string().max(64).optional(),
})
export type MessagePostInput = z.infer<typeof MessagePostInput>

export const MessageEditInput = z.object({
  body: RichBody,
  text: z.string().max(20000),
  mentions: z.array(Uuid).default([]),
  mentionedObjectIds: z.array(Uuid).default([]),
})
export type MessageEditInput = z.infer<typeof MessageEditInput>

export const MessageListQuery = z.object({
  before: z.string().optional(),
  after: z.string().optional(),
  threadRootId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type MessageListQuery = z.infer<typeof MessageListQuery>
