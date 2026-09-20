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
} from '@kchs/contracts'
import { z } from 'zod'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { ChatQueries } from './domain/chat-queries.js'
import { ChatService } from './domain/chat-service.js'
import { MessageSearch } from './domain/message-search.js'
import { ChatDrafts, ChatPins } from './domain/pins.js'
import { PresenceService } from './domain/presence.js'
import { QuickActions } from './domain/quick-actions.js'

const IdParam = z.object({ id: z.uuid() })
const MessageParam = z.object({ messageId: z.string().regex(/^\d+$/) })
const Ok = z.object({ ok: z.literal(true) })

/** Маршруты мессенджера (11-communications-meetings.md §1, ADR-0090). */
export function registerChatRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/chats',
    auth: 'session',
    tags: ['chat'],
    summary: 'Список бесед: закреплённые, непрочитанные, каналы, личные, обсуждения',
    schema: { querystring: ChatListQuery, response: { 200: ChatList } },
    handler: async (request) => {
      await PresenceService.touch(request.ctx.userId)
      return ChatQueries.list(request.ctx, request.query)
    },
  })

  route({
    method: 'POST',
    url: '/chats',
    auth: 'session',
    tags: ['chat'],
    summary: 'Завести личную беседу, группу или канал',
    schema: { body: ChatCreateInput, response: { 200: ChatListItem } },
    handler: async (request) => {
      const id = await db().transaction((tx) => ChatService.create(tx, request.ctx, request.body))
      return ChatQueries.one(request.ctx, id)
    },
  })

  route({
    method: 'GET',
    url: '/chats/search',
    auth: 'session',
    tags: ['chat'],
    summary: 'Поиск сообщений: по беседе или по всем доступным',
    schema: { querystring: ChatSearchQuery, response: { 200: ChatSearchResponse } },
    handler: async (request) => MessageSearch.run(request.ctx, request.query),
  })

  route({
    method: 'GET',
    url: '/chats/drafts',
    auth: 'session',
    tags: ['chat'],
    summary: 'Мои черновики сообщений',
    schema: { response: { 200: ChatDraftsSchema } },
    handler: async (request) => ({ items: await ChatDrafts.mine(request.ctx) }),
  })

  route({
    method: 'POST',
    url: '/chats/forward',
    auth: 'session',
    tags: ['chat'],
    summary: 'Переслать сообщения в другие беседы',
    schema: {
      body: ChatForwardInput,
      response: { 200: z.object({ posted: z.number().int() }) },
    },
    handler: async (request) =>
      db().transaction((tx) => QuickActions.forward(tx, request.ctx, request.body)),
  })

  route({
    method: 'GET',
    url: '/chats/:id',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Беседа: название, участники, права смотрящего',
    schema: { params: IdParam, response: { 200: ChatListItem } },
    handler: async (request) => ChatQueries.one(request.ctx, request.params.id),
  })

  route({
    method: 'PATCH',
    url: '/chats/:id',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Переименовать беседу',
    schema: { params: IdParam, body: ChatRenameInput, response: { 200: ChatListItem } },
    handler: async (request) => {
      await db().transaction((tx) =>
        ChatService.rename(tx, request.ctx, request.params.id, request.body.title),
      )
      return ChatQueries.one(request.ctx, request.params.id)
    },
  })

  route({
    method: 'GET',
    url: '/chats/:id/members',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Участники беседы',
    schema: { params: IdParam, response: { 200: ChatMembers } },
    handler: async (request) => ({
      items: await ChatService.members(request.ctx, request.params.id),
    }),
  })

  route({
    method: 'POST',
    url: '/chats/:id/join',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Вступить в открытый канал',
    schema: { params: IdParam, response: { 200: ChatListItem } },
    handler: async (request) => {
      await db().transaction((tx) => ChatService.join(tx, request.ctx, request.params.id))
      return ChatQueries.one(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/chats/:id/leave',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Выйти из беседы',
    schema: { params: IdParam, response: { 200: Ok } },
    handler: async (request) => {
      await db().transaction((tx) => ChatService.leave(tx, request.ctx, request.params.id))
      return { ok: true as const }
    },
  })

  route({
    method: 'POST',
    url: '/chats/:id/invite',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Пригласить участников',
    schema: {
      params: IdParam,
      body: ChatInviteInput,
      response: { 200: z.object({ added: z.array(z.uuid()) }) },
    },
    handler: async (request) => ({
      added: await db().transaction((tx) =>
        ChatService.invite(tx, request.ctx, request.params.id, request.body.userIds),
      ),
    }),
  })

  route({
    method: 'DELETE',
    url: '/chats/:id/members/:userId',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Исключить участника',
    schema: {
      params: z.object({ id: z.uuid(), userId: z.uuid() }),
      response: { 200: Ok },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        ChatService.removeMember(tx, request.ctx, request.params.id, request.params.userId),
      )
      return { ok: true as const }
    },
  })

  route({
    method: 'PUT',
    url: '/chats/:id/settings',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Закрепить беседу или выключить звук',
    schema: { params: IdParam, body: ChatSettingsInput, response: { 200: ChatListItem } },
    handler: async (request) => {
      await ChatService.setSettings(request.ctx, request.params.id, request.body)
      return ChatQueries.one(request.ctx, request.params.id)
    },
  })

  route({
    method: 'GET',
    url: '/chats/:id/pins',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Закреплённые сообщения беседы',
    schema: { params: IdParam, response: { 200: ChatPinsSchema } },
    handler: async (request) => ({ items: await ChatPins.list(request.ctx, request.params.id) }),
  })

  route({
    method: 'PUT',
    url: '/chats/:id/pins',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Закрепить или открепить сообщение',
    schema: { params: IdParam, body: ChatPinInput, response: { 200: ChatPinsSchema } },
    handler: async (request) => {
      await db().transaction((tx) =>
        ChatPins.set(
          tx,
          request.ctx,
          request.params.id,
          Number(request.body.messageId),
          request.body.on,
        ),
      )
      return { items: await ChatPins.list(request.ctx, request.params.id) }
    },
  })

  route({
    method: 'PUT',
    url: '/chats/:id/draft',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Сохранить черновик беседы или треда',
    schema: { params: IdParam, body: ChatDraftInput, response: { 200: Ok } },
    handler: async (request) => {
      await ChatDrafts.save(request.ctx, request.params.id, request.body)
      return { ok: true as const }
    },
  })

  route({
    method: 'POST',
    url: '/chats/:id/call',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Начать звонок из беседы',
    schema: { params: IdParam, body: ChatCallInput, response: { 200: ChatCallResult } },
    handler: async (request) => ({
      meetingId: await db().transaction((tx) =>
        QuickActions.call(tx, request.ctx, request.params.id, request.body.title),
      ),
    }),
  })

  route({
    method: 'POST',
    url: '/chats/messages/:messageId/task',
    auth: 'session',
    tags: ['chat'],
    summary: 'Поручение по сообщению: цитата и связь с источником',
    schema: { params: MessageParam, body: ChatTaskInput, response: { 200: ChatTaskResult } },
    handler: async (request) =>
      db().transaction((tx) =>
        QuickActions.task(tx, request.ctx, Number(request.params.messageId), request.body),
      ),
  })

  route({
    method: 'POST',
    url: '/chats/messages/:messageId/attach',
    auth: 'session',
    tags: ['chat'],
    summary: 'Прикрепить сообщение к документу или объекту',
    schema: { params: MessageParam, body: ChatAttachInput, response: { 200: Ok } },
    handler: async (request) => {
      await db().transaction((tx) =>
        QuickActions.attach(
          tx,
          request.ctx,
          Number(request.params.messageId),
          request.body.objectId,
        ),
      )
      return { ok: true as const }
    },
  })

  route({
    method: 'GET',
    url: '/me/presence',
    auth: 'session',
    tags: ['chat'],
    summary: 'Мой статус: выбранный и действующий, тихие часы',
    schema: { response: { 200: PresenceState } },
    handler: async (request) => PresenceService.get(request.ctx.userId, request.ctx.timezone),
  })

  route({
    method: 'PUT',
    url: '/me/presence',
    auth: 'session',
    tags: ['chat'],
    summary: 'Сменить статус, включить «не беспокоить» или тихие часы',
    schema: { body: PresenceUpdateInput, response: { 200: PresenceState } },
    handler: async (request) => PresenceService.update(request.ctx, request.body),
  })

  route({
    method: 'GET',
    url: '/presence',
    auth: 'session',
    tags: ['chat'],
    summary: 'Статусы собеседников',
    schema: { querystring: PresenceQuery, response: { 200: PresenceList } },
    handler: async (request) => ({
      items: await PresenceService.many(request.query.userIds, request.ctx.timezone),
    }),
  })
}
