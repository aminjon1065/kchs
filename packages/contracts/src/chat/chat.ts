import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { Timestamp, Uuid } from '../common/primitives.js'
import { ConversationKind, MessageKind, RichBody } from '../discussions/message.js'
import { TaskPriority } from '../tasks/task.js'

/**
 * Мессенджер (11-communications-meetings.md §1, ADR-0090). Беседа — объект
 * реестра `conversation` ядра: обсуждение объекта и чат — одна сущность
 * (02-platform-kernel.md §6). Здесь — то, что добавляет модуль «Чаты»:
 * виды бесед, участники, список с непрочитанным, закрепления, черновики,
 * поиск сообщений, присутствие и быстрые действия из сообщения.
 */

/** Виды бесед, которые заводит пользователь; `object` создаёт ядро при первом сообщении. */
export const CHAT_KINDS = ['direct', 'group', 'channel'] as const
export const ChatKind = z.enum(CHAT_KINDS)
export type ChatKind = z.infer<typeof ChatKind>

/** Владелец переименовывает беседу, приглашает и удаляет; участник — пишет. */
export const CHAT_MEMBER_ROLES = ['owner', 'member'] as const
export const ChatMemberRole = z.enum(CHAT_MEMBER_ROLES)
export type ChatMemberRole = z.infer<typeof ChatMemberRole>

/** Открытый канал: вступает любой из пространства; закрытый — по приглашению. */
export const ChatPrivacy = z.enum(['open', 'closed'])
export type ChatPrivacy = z.infer<typeof ChatPrivacy>

export const ChatLastMessage = z.object({
  id: z.string(),
  kind: MessageKind,
  text: z.string(),
  author: UserRef.nullable(),
  systemKey: z.string().nullable(),
  createdAt: Timestamp,
})
export type ChatLastMessage = z.infer<typeof ChatLastMessage>

export const ChatPermissions = z.object({
  post: z.boolean(),
  manage: z.boolean(),
  /** Из личной беседы и обсуждения объекта не выходят. */
  leave: z.boolean(),
  /** Открытый канал, в котором я не состою. */
  join: z.boolean(),
})

export const ChatListItem = z.object({
  id: Uuid,
  kind: ConversationKind,
  title: z.string(),
  /** Имя значка Lucide: у обсуждения объекта — значок его типа. */
  icon: z.string().nullable(),
  spaceId: Uuid.nullable(),
  spaceName: z.string().nullable(),
  privacy: ChatPrivacy,
  /** Обсуждение объекта: сам объект. */
  objectId: Uuid.nullable(),
  objectType: z.string().nullable(),
  /** Собеседник личной беседы — для имени и присутствия. */
  peer: UserRef.nullable(),
  lastMessage: ChatLastMessage.nullable(),
  lastMessageAt: Timestamp.nullable(),
  unreadCount: z.number().int(),
  unreadMentions: z.number().int(),
  /** «Непрочитанные с …»: первое непрочитанное сообщение ленты. */
  firstUnreadMessageId: z.string().nullable(),
  pinned: z.boolean(),
  muted: z.boolean(),
  /**
   * В архиве смотрящего (ADR-0161): скрыта из разделов, пока нет нового
   * сообщения; беседа без звука остаётся в архиве и с новыми сообщениями.
   */
  archived: z.boolean(),
  memberCount: z.number().int(),
  role: ChatMemberRole.nullable(),
  member: z.boolean(),
  can: ChatPermissions,
})
export type ChatListItem = z.infer<typeof ChatListItem>

/** Разделы списка бесед (11-communications-meetings.md §1). */
export const CHAT_SECTIONS = [
  'all',
  'pinned',
  'unread',
  'channels',
  'direct',
  'discussions',
  /** Открытые каналы моих пространств, в которых я не состою. */
  'discover',
  /** Архив смотрящего: беседы, скрытые из остальных разделов. */
  'archived',
] as const
export const ChatSection = z.enum(CHAT_SECTIONS)
export type ChatSection = z.infer<typeof ChatSection>

export const ChatListQuery = z.object({
  section: ChatSection.default('all'),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})
export type ChatListQuery = z.infer<typeof ChatListQuery>

export const ChatList = z.object({
  items: z.array(ChatListItem),
  /** Сумма непрочитанного по всем беседам — значок на рейке. */
  totalUnread: z.number().int(),
})
export type ChatList = z.infer<typeof ChatList>

export const ChatCreateInput = z.object({
  kind: ChatKind,
  title: z.string().max(200).optional(),
  memberIds: z.array(Uuid).max(500).default([]),
  /** Канал живёт в пространстве; личная беседа и группа — в системном пространстве чатов. */
  spaceId: Uuid.nullable().optional(),
  privacy: ChatPrivacy.default('closed'),
})
export type ChatCreateInput = z.infer<typeof ChatCreateInput>

export const ChatRenameInput = z.object({ title: z.string().min(1).max(200) })
export type ChatRenameInput = z.infer<typeof ChatRenameInput>

export const ChatInviteInput = z.object({ userIds: z.array(Uuid).min(1).max(200) })
export type ChatInviteInput = z.infer<typeof ChatInviteInput>

export const ChatSettingsInput = z.object({
  pinned: z.boolean().optional(),
  muted: z.boolean().optional(),
  /** Убрать в архив или вернуть; в архиве беседа не закреплена. */
  archived: z.boolean().optional(),
})
export type ChatSettingsInput = z.infer<typeof ChatSettingsInput>

export const ChatMember = z.object({
  user: UserRef,
  role: ChatMemberRole,
  joinedAt: Timestamp,
  lastReadMessageId: z.string().nullable(),
})
export type ChatMember = z.infer<typeof ChatMember>

export const ChatMembers = z.object({ items: z.array(ChatMember) })

export const ChatPin = z.object({
  messageId: z.string(),
  text: z.string(),
  author: UserRef.nullable(),
  pinnedBy: UserRef.nullable(),
  pinnedAt: Timestamp,
})
export type ChatPin = z.infer<typeof ChatPin>

export const ChatPins = z.object({ items: z.array(ChatPin) })

export const ChatPinInput = z.object({ messageId: z.string(), on: z.boolean() })
export type ChatPinInput = z.infer<typeof ChatPinInput>

export const ChatDraft = z.object({
  conversationId: Uuid,
  threadRootId: z.string().nullable(),
  body: RichBody.nullable(),
  text: z.string(),
  updatedAt: Timestamp,
})
export type ChatDraft = z.infer<typeof ChatDraft>

export const ChatDrafts = z.object({ items: z.array(ChatDraft) })

export const ChatDraftInput = z.object({
  threadRootId: z.string().nullable().default(null),
  body: RichBody.nullable().default(null),
  text: z.string().max(20000).default(''),
})
export type ChatDraftInput = z.infer<typeof ChatDraftInput>

export const ChatForwardInput = z.object({
  messageIds: z.array(z.string()).min(1).max(20),
  toConversationIds: z.array(Uuid).min(1).max(10),
  comment: z.string().max(2000).optional(),
})
export type ChatForwardInput = z.infer<typeof ChatForwardInput>

export const ChatSearchQuery = z.object({
  q: z.string().min(2).max(200),
  /** Поиск по одной беседе; без него — по всем доступным. */
  conversationId: Uuid.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(1000).default(0),
})
export type ChatSearchQuery = z.infer<typeof ChatSearchQuery>

export const ChatSearchHit = z.object({
  messageId: z.string(),
  conversationId: Uuid,
  conversationTitle: z.string(),
  conversationKind: ConversationKind,
  author: UserRef.nullable(),
  /** Фрагмент с подсветкой `<mark>` — из индекса. */
  snippet: z.string(),
  createdAt: Timestamp,
})
export type ChatSearchHit = z.infer<typeof ChatSearchHit>

export const ChatSearchResponse = z.object({
  hits: z.array(ChatSearchHit),
  total: z.number().int(),
})
export type ChatSearchResponse = z.infer<typeof ChatSearchResponse>

// ─── Присутствие и статусы (S03) ─────────────────────────────────────────────

/** Что видит собеседник; `in_meeting` выставляется автоматически. */
export const PRESENCE_STATUSES = ['online', 'away', 'dnd', 'in_meeting', 'offline'] as const
export const PresenceStatus = z.enum(PRESENCE_STATUSES)
export type PresenceStatus = z.infer<typeof PresenceStatus>

/** Что выбирает сам пользователь. */
export const PRESENCE_CHOICES = ['online', 'away', 'dnd'] as const
export const PresenceChoice = z.enum(PRESENCE_CHOICES)
export type PresenceChoice = z.infer<typeof PresenceChoice>

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'время в формате ЧЧ:ММ')

export const QuietHours = z.object({
  enabled: z.boolean().default(false),
  from: Hhmm.default('21:00'),
  to: Hhmm.default('08:00'),
})
export type QuietHours = z.infer<typeof QuietHours>

export const PresenceState = z.object({
  userId: Uuid,
  /** Действующий статус: «на встрече» и тихие часы поверх выбранного. */
  status: PresenceStatus,
  chosen: PresenceChoice,
  /** До какого момента держится выбранный статус. */
  until: Timestamp.nullable(),
  inMeeting: z.boolean(),
  quietHours: QuietHours,
  lastSeenAt: Timestamp.nullable(),
})
export type PresenceState = z.infer<typeof PresenceState>

export const PresenceList = z.object({ items: z.array(PresenceState) })

export const PresenceUpdateInput = z.object({
  status: PresenceChoice.optional(),
  /** «Не беспокоить час»: сколько минут держать статус; `null` — бессрочно. */
  untilMinutes: z.number().int().min(0).max(1440).nullable().optional(),
  quietHours: QuietHours.optional(),
})
export type PresenceUpdateInput = z.infer<typeof PresenceUpdateInput>

export const PresenceQuery = z.object({
  userIds: z
    .string()
    .max(4000)
    .transform((value) => value.split(',').filter(Boolean))
    .pipe(z.array(Uuid).max(100)),
})

// ─── Быстрые действия из сообщения (S04) ─────────────────────────────────────

export const ChatTaskInput = z.object({
  title: z.string().min(1).max(300),
  /** Без исполнителя поручение ставится себе. */
  assigneeId: Uuid.optional(),
  dueAt: Timestamp.optional(),
  dueWorkingDays: z.number().int().min(1).max(60).default(3),
  priority: TaskPriority.default(3),
})
export type ChatTaskInput = z.infer<typeof ChatTaskInput>

export const ChatTaskResult = z.object({ taskId: Uuid, key: z.string() })

export const ChatAttachInput = z.object({ objectId: Uuid })
export type ChatAttachInput = z.infer<typeof ChatAttachInput>

export const ChatCallInput = z.object({ title: z.string().max(200).optional() })
export type ChatCallInput = z.infer<typeof ChatCallInput>

export const ChatCallResult = z.object({ meetingId: Uuid })
