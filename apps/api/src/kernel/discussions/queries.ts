import type { ConversationKind, MessageKind } from '@kchs/contracts'
import { and, asc, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm'
import type { UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { visibleObjectsSql } from '../access/authorize.js'
import { objects } from '../objects/schema.js'
import { conversationMembers, conversations, messages } from './schema.js'

/**
 * Непрочитанное беседы — одно определение для обсуждения объекта и списка
 * бесед (ADR-0184): чужие неудалённые сообщения после отметки прочтения, а без
 * неё — после вступления в беседу (`conversation_members.created_at`), иначе
 * после собственного последнего сообщения (обсуждение объекта, где отметок ещё
 * нет), иначе все. Псевдонимы запроса: `unread` — строка `messages`, `cm` —
 * строка участника смотрящего (может отсутствовать), `c` — беседа.
 */
function unreadSql(userId: string): SQL {
  return sql`unread.conversation_id = c.id
      AND unread.deleted_at IS NULL
      AND unread.author_id IS DISTINCT FROM ${userId}
      AND CASE
        WHEN cm.last_read_message_id IS NOT NULL THEN unread.id > cm.last_read_message_id
        ELSE unread.created_at > coalesce(
               cm.created_at,
               (SELECT max(own.created_at) FROM messages own
                 WHERE own.conversation_id = c.id AND own.author_id = ${userId}),
               '-infinity'::timestamptz)
      END`
}

/** Какие беседы смотрящего нужны списку. */
export type ConversationScope =
  /** Участник или писал в обсуждении объекта. */
  | { kind: 'mine' }
  /** «Куда вступить»: открытые каналы, где смотрящий ещё не состоит. */
  | { kind: 'discover' }
  | { kind: 'one'; conversationId: string }

export interface InboxRow {
  id: string
  kind: ConversationKind
  privacy: string
  objectId: string | null
  subjectType: string | null
  title: string
  spaceId: string | null
  spaceName: string | null
  ownerId: string | null
  isMember: boolean
  role: string | null
  pinned: boolean
  muted: boolean
  archived: boolean
  memberCount: number
  peerId: string | null
  lastMessageAt: string | null
  unreadCount: number
  unreadMentions: number
  firstUnreadId: string | null
  lastMessage: {
    id: string
    kind: MessageKind
    text: string
    systemKey: string | null
    authorId: string | null
    createdAt: string
  } | null
}

interface RawInboxRow extends Record<string, unknown> {
  id: string
  kind: string
  privacy: string
  object_id: string | null
  subject_type: string | null
  title: string
  space_id: string | null
  space_name: string | null
  owner_id: string | null
  is_member: boolean
  role: string | null
  pinned: boolean
  muted: boolean
  archived: boolean
  member_count: number
  peer_id: string | null
  last_message_at: string | null
  unread_count: number
  unread_mentions: number
  first_unread: string | null
  lm_id: string | null
  lm_kind: string | null
  lm_text: string | null
  lm_system_key: string | null
  lm_author_id: string | null
  lm_created_at: string | null
}

/** `execute` отдаёт время драйвера (Date), а не строку типа-обёртки схемы. */
const iso = (value: unknown): string | null =>
  value === null || value === undefined ? null : new Date(value as string).toISOString()

export interface MessageRef {
  id: number
  conversationId: string
  authorId: string | null
  kind: string
  text: string
  createdAt: string
  deletedAt: string | null
}

export interface ConversationBrief {
  id: string
  kind: ConversationKind
  privacy: string
  objectId: string | null
  spaceId: string | null
  title: string
  ownerId: string | null
}

const messageRefColumns = {
  id: messages.id,
  conversationId: messages.conversationId,
  authorId: messages.authorId,
  kind: messages.kind,
  text: messages.text,
  createdAt: messages.createdAt,
  deletedAt: messages.deletedAt,
}

/**
 * Чтения бесед и сообщений для модулей (ADR-0184): таблицы обсуждений — ядра,
 * модуль чатов получает из них только то, что ему нужно, через эти функции.
 */
export const DiscussionQueries = {
  /**
   * Беседы смотрящего с непрочитанным и последним сообщением. Видимость —
   * предикат ядра (`visibleObjectsSql`): закрытый канал и обсуждение недоступного
   * объекта в список не попадут.
   */
  async inbox(ctx: UserCtx, scope: ConversationScope, limit: number): Promise<InboxRow[]> {
    const me = ctx.userId
    const visible = visibleObjectsSql(ctx, 'conversation')
    const where =
      scope.kind === 'one'
        ? sql`c.id = ${scope.conversationId}::uuid`
        : scope.kind === 'discover'
          ? sql`c.kind = 'channel' AND c.privacy = 'open' AND cm.user_id IS NULL`
          : sql`(cm.user_id IS NOT NULL
               OR (c.kind = 'object' AND EXISTS (
                     SELECT 1 FROM messages mine
                      WHERE mine.conversation_id = c.id AND mine.author_id = ${me})))`
    const unread = unreadSql(me)

    const found = await db().execute<RawInboxRow>(sql`
      SELECT c.id,
             c.kind,
             c.privacy,
             c.object_id,
             subject.type AS subject_type,
             ${objects.title} AS title,
             ${objects.spaceId} AS space_id,
             space.title AS space_name,
             ${objects.ownerId} AS owner_id,
             (cm.user_id IS NOT NULL) AS is_member,
             cm.role,
             coalesce(cm.pinned, false) AS pinned,
             (cm.muted_until IS NOT NULL AND cm.muted_until > now()) AS muted,
             -- Архив до нового сообщения; беседа без звука остаётся в архиве и с ним
             (cm.archived_at IS NOT NULL
               AND ((cm.muted_until IS NOT NULL AND cm.muted_until > now())
                    OR c.last_message_at IS NULL
                    OR c.last_message_at <= cm.archived_at)) AS archived,
             (SELECT count(*)::int FROM conversation_members mc WHERE mc.conversation_id = c.id)
               AS member_count,
             (SELECT peer.user_id FROM conversation_members peer
               WHERE peer.conversation_id = c.id AND peer.user_id <> ${me} LIMIT 1) AS peer_id,
             c.last_message_at,
             (SELECT count(*)::int FROM messages unread WHERE ${unread}) AS unread_count,
             (SELECT count(*)::int FROM messages unread
               WHERE ${unread} AND ${me}::uuid = ANY(unread.mentions)) AS unread_mentions,
             (SELECT min(unread.id)::text FROM messages unread WHERE ${unread}) AS first_unread,
             lm.id::text AS lm_id,
             lm.kind AS lm_kind,
             lm.text AS lm_text,
             lm.system_key AS lm_system_key,
             lm.author_id AS lm_author_id,
             lm.created_at AS lm_created_at
        FROM ${conversations} c
        JOIN ${objects} ON ${objects.id} = c.id
        LEFT JOIN ${objects} subject ON subject.id = c.object_id
        LEFT JOIN ${objects} space ON space.id = ${objects.spaceId}
        LEFT JOIN ${conversationMembers} cm ON cm.conversation_id = c.id AND cm.user_id = ${me}
        LEFT JOIN LATERAL (
          SELECT m.id, m.kind, m.text, m.system_key, m.author_id, m.created_at
            FROM ${messages} m
           WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
           ORDER BY m.id DESC LIMIT 1) lm ON true
       WHERE ${objects.deletedAt} IS NULL
         AND ${visible}
         AND ${where}
       ORDER BY coalesce(cm.pinned, false) DESC, c.last_message_at DESC NULLS LAST, c.id DESC
       LIMIT ${limit}`)

    return found.map((row) => ({
      id: row.id,
      kind: row.kind as ConversationKind,
      privacy: row.privacy,
      objectId: row.object_id,
      subjectType: row.subject_type,
      title: row.title,
      spaceId: row.space_id,
      spaceName: row.space_name,
      ownerId: row.owner_id,
      isMember: Boolean(row.is_member),
      role: row.role,
      pinned: Boolean(row.pinned),
      muted: Boolean(row.muted),
      archived: Boolean(row.archived),
      memberCount: Number(row.member_count ?? 0),
      peerId: row.peer_id,
      lastMessageAt: iso(row.last_message_at),
      unreadCount: Number(row.unread_count ?? 0),
      unreadMentions: Number(row.unread_mentions ?? 0),
      firstUnreadId: row.first_unread,
      lastMessage: row.lm_id
        ? {
            id: row.lm_id,
            kind: (row.lm_kind ?? 'user') as MessageKind,
            text: row.lm_text ?? '',
            systemKey: row.lm_system_key,
            authorId: row.lm_author_id,
            createdAt: iso(row.lm_created_at) ?? new Date().toISOString(),
          }
        : null,
    }))
  },

  /** Непрочитанное смотрящего в одной беседе — то же определение, что у списка. */
  async unreadCount(userId: string, conversationId: string): Promise<number> {
    const unread = unreadSql(userId)
    const [row] = await db().execute<{ count: number }>(sql`
      SELECT (SELECT count(*)::int FROM messages unread WHERE ${unread}) AS count
        FROM ${conversations} c
        LEFT JOIN ${conversationMembers} cm ON cm.conversation_id = c.id AND cm.user_id = ${userId}
       WHERE c.id = ${conversationId}::uuid`)
    return Number(row?.count ?? 0)
  },

  /** Беседа с полями её объекта; `null` — беседы нет. */
  async conversation(executor: Executor, id: string): Promise<ConversationBrief | null> {
    const [row] = await executor
      .select({
        id: conversations.id,
        kind: conversations.kind,
        privacy: conversations.privacy,
        objectId: conversations.objectId,
        spaceId: objects.spaceId,
        title: objects.title,
        ownerId: objects.ownerId,
      })
      .from(conversations)
      .innerJoin(objects, eq(objects.id, conversations.id))
      .where(eq(conversations.id, id))
      .limit(1)
    return row ? { ...row, kind: row.kind as ConversationKind } : null
  },

  /** Вид и название бесед — для выдачи поиска сообщений. */
  async briefs(ids: string[]): Promise<Map<string, ConversationBrief>> {
    if (ids.length === 0) return new Map()
    const rows = await db()
      .select({
        id: conversations.id,
        kind: conversations.kind,
        privacy: conversations.privacy,
        objectId: conversations.objectId,
        spaceId: objects.spaceId,
        title: objects.title,
        ownerId: objects.ownerId,
      })
      .from(conversations)
      .innerJoin(objects, eq(objects.id, conversations.id))
      .where(inArray(conversations.id, ids))
    return new Map(rows.map((row) => [row.id, { ...row, kind: row.kind as ConversationKind }]))
  },

  /** Беседы, где пользователь состоит или писал: фильтр глобального поиска сообщений. */
  async involving(userId: string, limit = 500): Promise<string[]> {
    const rows = await db().execute<{ id: string }>(sql`
      SELECT c.id FROM ${conversations} c
       WHERE EXISTS (
               SELECT 1 FROM ${conversationMembers} cm
                WHERE cm.conversation_id = c.id AND cm.user_id = ${userId})
          OR EXISTS (
               SELECT 1 FROM ${messages} msg
                WHERE msg.conversation_id = c.id AND msg.author_id = ${userId})
       ORDER BY c.last_message_at DESC NULLS LAST
       LIMIT ${limit}`)
    return rows.map((row) => row.id)
  },

  async message(executor: Executor, messageId: number): Promise<MessageRef | null> {
    const [row] = await executor
      .select(messageRefColumns)
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
    return row ?? null
  },

  /** Сообщения по идентификаторам в порядке отправки; `live` — без удалённых. */
  async messages(
    executor: Executor,
    ids: number[],
    options: { live?: boolean } = {},
  ): Promise<MessageRef[]> {
    if (ids.length === 0) return []
    return executor
      .select(messageRefColumns)
      .from(messages)
      .where(and(inArray(messages.id, ids), options.live ? isNull(messages.deletedAt) : undefined))
      .orderBy(asc(messages.id))
  },

  /**
   * Поиск по тексту в одной беседе: индекс триграмм `messages_text_trgm`, найденное
   * видно сразу после отправки. Права на беседу проверяет вызывающий.
   */
  async search(
    conversationId: string,
    q: string,
    page: { limit: number; offset: number },
  ): Promise<MessageRef[]> {
    return db()
      .select(messageRefColumns)
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          isNull(messages.deletedAt),
          sql`${messages.text} ILIKE ${`%${q}%`}`,
        ),
      )
      .orderBy(desc(messages.id))
      .limit(page.limit)
      .offset(page.offset)
  },
}
