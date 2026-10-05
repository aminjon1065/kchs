import { z } from 'zod'
import {
  ChatAttachInput,
  ChatCallInput,
  ChatCallResult,
  ChatCreateInput,
  ChatDraftInput,
  ChatDrafts as ChatDraftsSchema,
  ChatForwardInput,
  ChatInviteInput,
  ChatList,
  ChatListItem,
  ChatListQuery,
  ChatMembers,
  ChatPinInput,
  ChatPins as ChatPinsSchema,
  ChatRenameInput,
  ChatSearchQuery,
  ChatSearchResponse,
  ChatSettingsInput,
  ChatTaskInput,
  ChatTaskResult,
  PresenceList,
  PresenceQuery,
  PresenceState,
  PresenceUpdateInput,
} from '../../chat/chat.js'
import { defineRoutes } from '../../http/route-contract.js'

const IdParam = z.object({ id: z.uuid() })

const Ok = z.object({ ok: z.literal(true) })

const MessageParam = z.object({ messageId: z.string().regex(/^\d+$/) })

/**
 * Маршруты модуля «chat» (ADR-0188). Регистрация — `apps/api/src/modules/chat/`: http.ts.
 */
export const chatRoutes = defineRoutes({
  'GET /chats': { query: ChatListQuery, response: { 200: ChatList } },
  'POST /chats': { body: ChatCreateInput, response: { 200: ChatListItem } },
  'GET /chats/search': { query: ChatSearchQuery, response: { 200: ChatSearchResponse } },
  'GET /chats/drafts': { response: { 200: ChatDraftsSchema } },
  'POST /chats/forward': {
    body: ChatForwardInput,
    response: { 200: z.object({ posted: z.number().int() }) },
  },
  'GET /chats/:id': { params: IdParam, response: { 200: ChatListItem } },
  'PATCH /chats/:id': { params: IdParam, body: ChatRenameInput, response: { 200: ChatListItem } },
  'GET /chats/:id/members': { params: IdParam, response: { 200: ChatMembers } },
  'POST /chats/:id/join': { params: IdParam, response: { 200: ChatListItem } },
  'POST /chats/:id/leave': { params: IdParam, response: { 200: Ok } },
  'POST /chats/:id/invite': {
    params: IdParam,
    body: ChatInviteInput,
    response: { 200: z.object({ added: z.array(z.uuid()) }) },
  },
  'DELETE /chats/:id/members/:userId': {
    params: z.object({ id: z.uuid(), userId: z.uuid() }),
    response: { 200: Ok },
  },
  'PUT /chats/:id/settings': {
    params: IdParam,
    body: ChatSettingsInput,
    response: { 200: ChatListItem },
  },
  'GET /chats/:id/pins': { params: IdParam, response: { 200: ChatPinsSchema } },
  'PUT /chats/:id/pins': { params: IdParam, body: ChatPinInput, response: { 200: ChatPinsSchema } },
  'PUT /chats/:id/draft': { params: IdParam, body: ChatDraftInput, response: { 200: Ok } },
  'POST /chats/:id/call': {
    params: IdParam,
    body: ChatCallInput,
    response: { 200: ChatCallResult },
  },
  'POST /chats/messages/:messageId/task': {
    params: MessageParam,
    body: ChatTaskInput,
    response: { 200: ChatTaskResult },
  },
  'POST /chats/messages/:messageId/attach': {
    params: MessageParam,
    body: ChatAttachInput,
    response: { 200: Ok },
  },
  'GET /me/presence': { response: { 200: PresenceState } },
  'PUT /me/presence': { body: PresenceUpdateInput, response: { 200: PresenceState } },
  'GET /presence': { query: PresenceQuery, response: { 200: PresenceList } },
})
