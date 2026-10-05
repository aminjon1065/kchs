import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { ChatQueries } from './domain/chat-queries.js'
import { ChatService } from './domain/chat-service.js'
import { MessageSearch } from './domain/message-search.js'
import { ChatDrafts, ChatPins } from './domain/pins.js'
import { PresenceService } from './domain/presence.js'
import { QuickActions } from './domain/quick-actions.js'

/** Маршруты мессенджера (11-communications-meetings.md §1, ADR-0090). */
export function registerChatRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /chats',
    auth: 'session',
    tags: ['chat'],
    summary: 'Список бесед: закреплённые, непрочитанные, каналы, личные, обсуждения',
    handler: async (request) => {
      await PresenceService.touch(request.ctx.userId)
      return ChatQueries.list(request.ctx, request.query)
    },
  })

  route({
    route: 'POST /chats',
    auth: 'session',
    tags: ['chat'],
    summary: 'Завести личную беседу, группу или канал',
    handler: async (request) => {
      const id = await db().transaction((tx) => ChatService.create(tx, request.ctx, request.body))
      return ChatQueries.one(request.ctx, id)
    },
  })

  route({
    route: 'GET /chats/search',
    auth: 'session',
    tags: ['chat'],
    summary: 'Поиск сообщений: по беседе или по всем доступным',
    handler: async (request) => MessageSearch.run(request.ctx, request.query),
  })

  route({
    route: 'GET /chats/drafts',
    auth: 'session',
    tags: ['chat'],
    summary: 'Мои черновики сообщений',
    handler: async (request) => ({ items: await ChatDrafts.mine(request.ctx) }),
  })

  route({
    route: 'POST /chats/forward',
    auth: 'session',
    tags: ['chat'],
    summary: 'Переслать сообщения в другие беседы',
    handler: async (request) =>
      db().transaction((tx) => QuickActions.forward(tx, request.ctx, request.body)),
  })

  route({
    route: 'GET /chats/:id',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Беседа: название, участники, права смотрящего',
    handler: async (request) => ChatQueries.one(request.ctx, request.params.id),
  })

  route({
    route: 'PATCH /chats/:id',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Переименовать беседу',
    handler: async (request) => {
      await db().transaction((tx) =>
        ChatService.rename(tx, request.ctx, request.params.id, request.body.title),
      )
      return ChatQueries.one(request.ctx, request.params.id)
    },
  })

  route({
    route: 'GET /chats/:id/members',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Участники беседы',
    handler: async (request) => ({
      items: await ChatService.members(request.ctx, request.params.id),
    }),
  })

  route({
    route: 'POST /chats/:id/join',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Вступить в открытый канал',
    handler: async (request) => {
      await db().transaction((tx) => ChatService.join(tx, request.ctx, request.params.id))
      return ChatQueries.one(request.ctx, request.params.id)
    },
  })

  route({
    route: 'POST /chats/:id/leave',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Выйти из беседы',
    handler: async (request) => {
      await db().transaction((tx) => ChatService.leave(tx, request.ctx, request.params.id))
      return { ok: true as const }
    },
  })

  route({
    route: 'POST /chats/:id/invite',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Пригласить участников',
    handler: async (request) => ({
      added: await db().transaction((tx) =>
        ChatService.invite(tx, request.ctx, request.params.id, request.body.userIds),
      ),
    }),
  })

  route({
    route: 'DELETE /chats/:id/members/:userId',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Исключить участника',
    handler: async (request) => {
      await db().transaction((tx) =>
        ChatService.removeMember(tx, request.ctx, request.params.id, request.params.userId),
      )
      return { ok: true as const }
    },
  })

  route({
    route: 'PUT /chats/:id/settings',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Закрепить беседу или выключить звук',
    handler: async (request) => {
      await ChatService.setSettings(request.ctx, request.params.id, request.body)
      return ChatQueries.one(request.ctx, request.params.id)
    },
  })

  route({
    route: 'GET /chats/:id/pins',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Закреплённые сообщения беседы',
    handler: async (request) => ({ items: await ChatPins.list(request.ctx, request.params.id) }),
  })

  route({
    route: 'PUT /chats/:id/pins',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Закрепить или открепить сообщение',
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
    route: 'PUT /chats/:id/draft',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Сохранить черновик беседы или треда',
    handler: async (request) => {
      await ChatDrafts.save(request.ctx, request.params.id, request.body)
      return { ok: true as const }
    },
  })

  route({
    route: 'POST /chats/:id/call',
    auth: { action: 'view' },
    tags: ['chat'],
    summary: 'Начать звонок из беседы',
    handler: async (request) => ({
      meetingId: await db().transaction((tx) =>
        QuickActions.call(tx, request.ctx, request.params.id, request.body.title),
      ),
    }),
  })

  route({
    route: 'POST /chats/messages/:messageId/task',
    auth: { delegated: 'QuickActions.task', resource: 'message' },
    tags: ['chat'],
    summary: 'Поручение по сообщению: цитата и связь с источником',
    handler: async (request) =>
      db().transaction((tx) =>
        QuickActions.task(tx, request.ctx, Number(request.params.messageId), request.body),
      ),
  })

  route({
    route: 'POST /chats/messages/:messageId/attach',
    auth: { delegated: 'QuickActions.attach', resource: 'message' },
    tags: ['chat'],
    summary: 'Прикрепить сообщение к документу или объекту',
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
    route: 'GET /me/presence',
    auth: 'session',
    tags: ['chat'],
    summary: 'Мой статус: выбранный и действующий, тихие часы',
    handler: async (request) => PresenceService.get(request.ctx.userId, request.ctx.timezone),
  })

  route({
    route: 'PUT /me/presence',
    auth: 'session',
    tags: ['chat'],
    summary: 'Сменить статус, включить «не беспокоить» или тихие часы',
    handler: async (request) => PresenceService.update(request.ctx, request.body),
  })

  route({
    route: 'GET /presence',
    auth: 'session',
    tags: ['chat'],
    summary: 'Статусы собеседников',
    handler: async (request) => ({
      items: await PresenceService.many(request.query.userIds, request.ctx.timezone),
    }),
  })
}
