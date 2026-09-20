import type { ChatListItem, ChatListQuery, ChatSection, MessageKind } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { visibleObjectsSql } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { objectType } from '~/kernel/objects/registry.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { conversations, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'

interface ListRow extends Record<string, unknown> {
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

/**
 * Список бесед смотрящего: беседы, где он участник, и обсуждения объектов, где
 * он писал. Видимость — предикат ядра (`visibleObjectsSql`), а не фильтр
 * модуля: закрытый канал и обсуждение недоступного объекта в список не попадут.
 */
async function rows(
  ctx: UserCtx,
  section: ChatSection,
  limit: number,
  only?: string,
): Promise<ListRow[]> {
  const me = ctx.userId
  const visible = visibleObjectsSql(ctx, 'conversation')

  // «Куда вступить»: открытые каналы пространств, где смотрящий ещё не состоит
  const scope = only
    ? sql`c.id = ${only}::uuid`
    : section === 'discover'
      ? sql`c.kind = 'channel' AND c.privacy = 'open' AND cm.user_id IS NULL`
      : sql`(cm.user_id IS NOT NULL
             OR (c.kind = 'object' AND EXISTS (
                   SELECT 1 FROM messages mine
                    WHERE mine.conversation_id = c.id AND mine.author_id = ${me})))`

  // Точка отсчёта непрочитанного: отметка прочтения, иначе вступление в беседу
  // (`conversation_members.created_at`), иначе собственное последнее сообщение —
  // обсуждение объекта, где отметок ещё нет
  const unreadFrom = sql`CASE
      WHEN cm.last_read_message_id IS NOT NULL THEN unread.id > cm.last_read_message_id
      ELSE unread.created_at > coalesce(
             cm.created_at,
             (SELECT max(m3.created_at) FROM messages m3
               WHERE m3.conversation_id = c.id AND m3.author_id = ${me}),
             '-infinity'::timestamptz)
    END`

  const unreadScope = sql`unread.conversation_id = c.id
      AND unread.deleted_at IS NULL
      AND unread.author_id IS DISTINCT FROM ${me}
      AND ${unreadFrom}`

  return db().execute<ListRow>(sql`
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
           (SELECT count(*)::int FROM conversation_members mc WHERE mc.conversation_id = c.id)
             AS member_count,
           (SELECT peer.user_id FROM conversation_members peer
             WHERE peer.conversation_id = c.id AND peer.user_id <> ${me} LIMIT 1) AS peer_id,
           c.last_message_at,
           (SELECT count(*)::int FROM messages unread WHERE ${unreadScope}) AS unread_count,
           (SELECT count(*)::int FROM messages unread
             WHERE ${unreadScope} AND ${me}::uuid = ANY(unread.mentions)) AS unread_mentions,
           (SELECT min(unread.id)::text FROM messages unread WHERE ${unreadScope}) AS first_unread,
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
      LEFT JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ${me}
      LEFT JOIN LATERAL (
        SELECT m.id, m.kind, m.text, m.system_key, m.author_id, m.created_at
          FROM messages m
         WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
         ORDER BY m.id DESC LIMIT 1) lm ON true
     WHERE ${objects.deletedAt} IS NULL
       AND ${visible}
       AND ${scope}
     ORDER BY coalesce(cm.pinned, false) DESC, c.last_message_at DESC NULLS LAST, c.id DESC
     LIMIT ${limit}`)
}

function matches(item: ChatListItem, section: ChatSection): boolean {
  switch (section) {
    case 'pinned':
      return item.pinned
    case 'unread':
      return item.unreadCount > 0
    case 'channels':
      return item.kind === 'channel' || item.kind === 'group'
    case 'direct':
      return item.kind === 'direct'
    case 'discussions':
      return item.kind === 'object'
    default:
      return true
  }
}

async function toItems(ctx: UserCtx, found: ListRow[]): Promise<ChatListItem[]> {
  const userIds = new Set<string>()
  for (const row of found) {
    if (row.peer_id) userIds.add(row.peer_id)
    if (row.lm_author_id) userIds.add(row.lm_author_id)
  }
  const refs = await directory().refs([...userIds])
  // `execute` отдаёт время драйвера (Date), а не строку типа-обёртки схемы
  const iso = (value: unknown): string | null =>
    value === null || value === undefined ? null : new Date(value as string).toISOString()

  return found.map((row) => {
    const peer = row.kind === 'direct' && row.peer_id ? (refs.get(row.peer_id) ?? null) : null
    const isMember = Boolean(row.is_member)
    const openChannel = row.kind === 'channel' && row.privacy === 'open'
    return {
      id: row.id,
      kind: row.kind as ChatListItem['kind'],
      // Имя личной беседы — собеседник, у обсуждения — название объекта
      title: peer?.displayName ?? row.title,
      icon:
        row.kind === 'object' && row.subject_type
          ? (objectType(row.subject_type)?.icon ?? null)
          : null,
      spaceId: row.space_id,
      spaceName: row.space_name,
      privacy: row.privacy === 'open' ? ('open' as const) : ('closed' as const),
      objectId: row.object_id,
      objectType: row.subject_type,
      peer,
      lastMessage: row.lm_id
        ? {
            id: row.lm_id,
            kind: (row.lm_kind ?? 'user') as MessageKind,
            text: row.lm_text ?? '',
            author: row.lm_author_id ? (refs.get(row.lm_author_id) ?? null) : null,
            systemKey: row.lm_system_key,
            createdAt: iso(row.lm_created_at) ?? new Date().toISOString(),
          }
        : null,
      lastMessageAt: iso(row.last_message_at),
      unreadCount: Number(row.unread_count ?? 0),
      unreadMentions: Number(row.unread_mentions ?? 0),
      firstUnreadMessageId: row.first_unread,
      pinned: Boolean(row.pinned),
      muted: Boolean(row.muted),
      memberCount: Number(row.member_count ?? 0),
      role: isMember ? (row.role === 'owner' ? ('owner' as const) : ('member' as const)) : null,
      member: isMember,
      can: {
        post: isMember || openChannel || row.kind === 'object',
        manage: row.owner_id === ctx.userId,
        leave: isMember && (row.kind === 'group' || row.kind === 'channel'),
        join: openChannel && !isMember,
      },
    }
  })
}

export const ChatQueries = {
  async list(
    ctx: UserCtx,
    query: ChatListQuery,
  ): Promise<{ items: ChatListItem[]; totalUnread: number }> {
    const items = await toItems(ctx, await rows(ctx, query.section, Math.max(query.limit, 100)))
    const needle = query.q?.trim().toLowerCase()
    return {
      items: items
        .filter((item) => matches(item, query.section))
        .filter((item) => !needle || item.title.toLowerCase().includes(needle))
        .slice(0, query.limit),
      totalUnread: items
        .filter((item) => !item.muted)
        .reduce((sum, item) => sum + item.unreadCount, 0),
    }
  },

  /** Одна беседа: шапка экрана «Чаты» и проверка прав после вступления. */
  async one(ctx: UserCtx, conversationId: string): Promise<ChatListItem> {
    const [item] = await toItems(ctx, await rows(ctx, 'all', 1, conversationId))
    if (!item) throw errors.notFound('Беседа')
    return item
  },
}
