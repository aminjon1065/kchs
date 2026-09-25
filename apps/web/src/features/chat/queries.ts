import type {
  ChatDraft,
  ChatList,
  ChatListItem,
  ChatMember,
  ChatPin,
  ChatSearchResponse,
  ChatSection,
  Message,
  PresenceState,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/**
 * Запросы модуля «Чаты» (ADR-0090). Сообщения лежат под ключом объекта-беседы
 * (`['object', id, 'discussion', …]`), поэтому их сбрасывает и realtime ядра, и
 * общий `keys.discussion(id)`; списки бесед — под своим ключом.
 */
export const chatKeys = {
  all: ['chats'] as const,
  list: (section: ChatSection) => ['chats', 'list', section] as const,
  conversation: (id: string) => ['chats', 'conversation', id] as const,
  messages: (id: string, threadRootId: string | null) =>
    ['object', id, 'discussion', threadRootId ?? 'feed'] as const,
  pins: (id: string) => ['chats', 'pins', id] as const,
  members: (id: string) => ['chats', 'members', id] as const,
  drafts: ['chats', 'drafts'] as const,
  search: (q: string, conversationId: string | null) =>
    ['chats', 'search', q, conversationId ?? 'all'] as const,
  presence: ['chats', 'presence'] as const,
  peers: (userIds: string) => ['chats', 'presence', userIds] as const,
}

export const chatListQuery = (section: ChatSection) =>
  queryOptions({
    queryKey: chatKeys.list(section),
    queryFn: () => http.get<ChatList>('/chats', { query: { section, limit: 100 } }),
    refetchInterval: 30_000,
  })

export const conversationQuery = (id: string | null) =>
  queryOptions({
    queryKey: chatKeys.conversation(id ?? 'none'),
    queryFn: () => http.get<ChatListItem>(`/chats/${id}`),
    enabled: Boolean(id),
  })

export const chatMessagesQuery = (id: string | null, threadRootId: string | null, limit = 50) =>
  queryOptions({
    queryKey: chatKeys.messages(id ?? 'none', threadRootId),
    queryFn: () =>
      http.get<{ items: Message[]; nextCursor: string | null }>(`/conversations/${id}/messages`, {
        query: { limit, ...(threadRootId ? { threadRootId } : {}) },
      }),
    enabled: Boolean(id),
  })

export const chatPinsQuery = (id: string | null) =>
  queryOptions({
    queryKey: chatKeys.pins(id ?? 'none'),
    queryFn: () => http.get<{ items: ChatPin[] }>(`/chats/${id}/pins`),
    enabled: Boolean(id),
  })

/** Участники с отметками прочтения — для «доставлено/прочитано» (ADR-0161). */
export const chatMembersQuery = (id: string | null) =>
  queryOptions({
    queryKey: chatKeys.members(id ?? 'none'),
    queryFn: () => http.get<{ items: ChatMember[] }>(`/chats/${id}/members`),
    enabled: Boolean(id),
  })

export const chatDraftsQuery = () =>
  queryOptions({
    queryKey: chatKeys.drafts,
    queryFn: () => http.get<{ items: ChatDraft[] }>('/chats/drafts'),
  })

export const chatSearchQuery = (q: string, conversationId: string | null) =>
  queryOptions({
    queryKey: chatKeys.search(q, conversationId),
    queryFn: () =>
      http.get<ChatSearchResponse>('/chats/search', {
        query: { q, ...(conversationId ? { conversationId } : {}) },
      }),
    enabled: q.trim().length >= 2,
  })

export const myPresenceQuery = () =>
  queryOptions({
    queryKey: chatKeys.presence,
    queryFn: () => http.get<PresenceState>('/me/presence'),
  })

export const peersPresenceQuery = (userIds: string[]) =>
  queryOptions({
    queryKey: chatKeys.peers(userIds.join(',')),
    queryFn: () =>
      http.get<{ items: PresenceState[] }>('/presence', { query: { userIds: userIds.join(',') } }),
    enabled: userIds.length > 0,
    refetchInterval: 60_000,
  })
