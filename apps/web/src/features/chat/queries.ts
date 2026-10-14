import type { ChatSection } from '@kchs/contracts'
import { queryOptions, skipToken } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

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
    queryFn: () => http.get('/chats', { query: { section, limit: 100 } }),
    refetchInterval: 30_000,
  })

export const conversationQuery = (id: string | null) =>
  queryOptions({
    queryKey: chatKeys.conversation(id ?? 'none'),
    queryFn: id ? () => http.get('/chats/:id', { params: { id } }) : skipToken,
  })

export const chatMessagesQuery = (id: string | null, threadRootId: string | null, limit = 50) =>
  queryOptions({
    queryKey: chatKeys.messages(id ?? 'none', threadRootId),
    queryFn: id
      ? () =>
          http.get('/conversations/:id/messages', {
            params: { id },
            query: { limit, ...(threadRootId ? { threadRootId } : {}) },
          })
      : skipToken,
  })

export const chatPinsQuery = (id: string | null) =>
  queryOptions({
    queryKey: chatKeys.pins(id ?? 'none'),
    queryFn: id ? () => http.get('/chats/:id/pins', { params: { id } }) : skipToken,
  })

/** Участники с отметками прочтения — для «доставлено/прочитано» (ADR-0161). */
export const chatMembersQuery = (id: string | null) =>
  queryOptions({
    queryKey: chatKeys.members(id ?? 'none'),
    queryFn: id ? () => http.get('/chats/:id/members', { params: { id } }) : skipToken,
  })

export const chatDraftsQuery = () =>
  queryOptions({
    queryKey: chatKeys.drafts,
    queryFn: () => http.get('/chats/drafts'),
  })

export const chatSearchQuery = (q: string, conversationId: string | null) =>
  queryOptions({
    queryKey: chatKeys.search(q, conversationId),
    queryFn: () =>
      http.get('/chats/search', { query: { q, ...(conversationId ? { conversationId } : {}) } }),
    enabled: q.trim().length >= 2,
  })

export const myPresenceQuery = () =>
  queryOptions({
    queryKey: chatKeys.presence,
    queryFn: () => http.get('/me/presence'),
  })

export const peersPresenceQuery = (userIds: string[]) =>
  queryOptions({
    queryKey: chatKeys.peers(userIds.join(',')),
    queryFn: () => http.get('/presence', { query: { userIds: userIds.join(',') } }),
    enabled: userIds.length > 0,
    refetchInterval: 60_000,
  })

export const chatApi = {
  create: (body: ApiBody<'POST /chats'>) => http.post('/chats', { body }),
  postChatsInvite: (id: string, body: ApiBody<'POST /chats/:id/invite'>) =>
    http.post('/chats/:id/invite', { params: { id }, body }),
  patchChats: (id: string, body: ApiBody<'PATCH /chats/:id'>) =>
    http.patch('/chats/:id', { params: { id }, body }),
  getChats: () => http.get('/chats', { query: { section: 'all' } }),
  postChatsForward: (body: ApiBody<'POST /chats/forward'>) => http.post('/chats/forward', { body }),
  postChatsMessagesTask: (
    messageId: string,
    body: ApiBody<'POST /chats/messages/:messageId/task'>,
  ) => http.post('/chats/messages/:messageId/task', { params: { messageId }, body }),
  postChatsMessagesAttach: (
    messageId: string,
    body: ApiBody<'POST /chats/messages/:messageId/attach'>,
  ) => http.post('/chats/messages/:messageId/attach', { params: { messageId }, body }),
  getMePresence: () => http.get('/me/presence'),
  putMePresence: (body: ApiBody<'PUT /me/presence'>) => http.put('/me/presence', { body }),
  postConversationsRead: (id: string, body: ApiBody<'POST /conversations/:id/read'>) =>
    http.post('/conversations/:id/read', { params: { id }, body }),
  putChatsDraft: (id: string, body: ApiBody<'PUT /chats/:id/draft'>) =>
    http.put('/chats/:id/draft', { params: { id }, body }),
  postAiTranslate: (body: ApiBody<'POST /ai/translate'>) => http.post('/ai/translate', { body }),
  postConversationsMessages: (id: string, body: ApiBody<'POST /conversations/:id/messages'>) =>
    http.post('/conversations/:id/messages', { params: { id }, body }),
  postChatsCall: (id: string) => http.post('/chats/:id/call', { params: { id }, body: {} }),
  putChatsSettings: (id: string, body: ApiBody<'PUT /chats/:id/settings'>) =>
    http.put('/chats/:id/settings', { params: { id }, body }),
  putChatsPins: (id: string, body: ApiBody<'PUT /chats/:id/pins'>) =>
    http.put('/chats/:id/pins', { params: { id }, body }),
  postChatsLeave: (id: string) => http.post('/chats/:id/leave', { params: { id } }),
  postChatsJoin: (id: string) => http.post('/chats/:id/join', { params: { id } }),
}
