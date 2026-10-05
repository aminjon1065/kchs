import type { ChatListItem, ChatListQuery, ChatSection } from '@kchs/contracts'
import { directory } from '~/kernel/directory/port.js'
import {
  type ConversationScope,
  DiscussionQueries,
  type InboxRow,
} from '~/kernel/discussions/queries.js'
import { objectType } from '~/kernel/objects/registry.js'
import type { UserCtx } from '~/shared/context.js'
import { errors } from '~/shared/errors.js'

/**
 * Список бесед смотрящего: беседы, где он участник, и обсуждения объектов, где
 * он писал. Строки, видимость и непрочитанное — ядра (`DiscussionQueries.inbox`,
 * ADR-0184); модуль раскладывает их по разделам экрана «Чаты».
 */
function scopeOf(section: ChatSection, only?: string): ConversationScope {
  if (only) return { kind: 'one', conversationId: only }
  return section === 'discover' ? { kind: 'discover' } : { kind: 'mine' }
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
    case 'archived':
      return item.archived
    default:
      return true
  }
}

/** Архивная беседа видна только в архиве; «Куда вступить» архива не знает. */
function inSection(item: ChatListItem, section: ChatSection): boolean {
  if (section === 'archived' || section === 'discover') return matches(item, section)
  return !item.archived && matches(item, section)
}

async function toItems(ctx: UserCtx, found: InboxRow[]): Promise<ChatListItem[]> {
  const userIds = new Set<string>()
  for (const row of found) {
    if (row.peerId) userIds.add(row.peerId)
    if (row.lastMessage?.authorId) userIds.add(row.lastMessage.authorId)
  }
  const refs = await directory().refs([...userIds])

  return found.map((row) => {
    const peer = row.kind === 'direct' && row.peerId ? (refs.get(row.peerId) ?? null) : null
    const openChannel = row.kind === 'channel' && row.privacy === 'open'
    return {
      id: row.id,
      kind: row.kind,
      // Имя личной беседы — собеседник, у обсуждения — название объекта
      title: peer?.displayName ?? row.title,
      icon:
        row.kind === 'object' && row.subjectType
          ? (objectType(row.subjectType)?.icon ?? null)
          : null,
      spaceId: row.spaceId,
      spaceName: row.spaceName,
      privacy: row.privacy === 'open' ? ('open' as const) : ('closed' as const),
      objectId: row.objectId,
      objectType: row.subjectType,
      peer,
      lastMessage: row.lastMessage
        ? {
            id: row.lastMessage.id,
            kind: row.lastMessage.kind,
            text: row.lastMessage.text,
            author: row.lastMessage.authorId ? (refs.get(row.lastMessage.authorId) ?? null) : null,
            systemKey: row.lastMessage.systemKey,
            systemParams: row.lastMessage.systemParams,
            createdAt: row.lastMessage.createdAt,
          }
        : null,
      lastMessageAt: row.lastMessageAt,
      unreadCount: row.unreadCount,
      unreadMentions: row.unreadMentions,
      firstUnreadMessageId: row.firstUnreadId,
      pinned: row.pinned,
      muted: row.muted,
      archived: row.archived,
      memberCount: row.memberCount,
      role: row.isMember ? (row.role === 'owner' ? ('owner' as const) : ('member' as const)) : null,
      member: row.isMember,
      can: {
        post: row.isMember || openChannel || row.kind === 'object',
        manage: row.ownerId === ctx.userId,
        leave: row.isMember && (row.kind === 'group' || row.kind === 'channel'),
        join: openChannel && !row.isMember,
      },
    }
  })
}

export const ChatQueries = {
  async list(
    ctx: UserCtx,
    query: ChatListQuery,
  ): Promise<{ items: ChatListItem[]; totalUnread: number }> {
    const found = await DiscussionQueries.inbox(
      ctx,
      scopeOf(query.section),
      Math.max(query.limit, 100),
    )
    const items = await toItems(ctx, found)
    const needle = query.q?.trim().toLowerCase()
    return {
      items: items
        .filter((item) => inSection(item, query.section))
        .filter((item) => !needle || item.title.toLowerCase().includes(needle))
        .slice(0, query.limit),
      totalUnread: items
        .filter((item) => !item.muted && !item.archived)
        .reduce((sum, item) => sum + item.unreadCount, 0),
    }
  },

  /** Одна беседа: шапка экрана «Чаты» и проверка прав после вступления. */
  async one(ctx: UserCtx, conversationId: string): Promise<ChatListItem> {
    const [item] = await toItems(
      ctx,
      await DiscussionQueries.inbox(ctx, scopeOf('all', conversationId), 1),
    )
    if (!item) throw errors.notFound('Беседа')
    return item
  },
}
