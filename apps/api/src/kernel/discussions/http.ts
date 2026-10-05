import { eq } from 'drizzle-orm'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { authorize } from '../access/authorize.js'
import { messages } from './schema.js'
import { DiscussionService } from './service.js'

export function registerDiscussionRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /objects/:id/discussion',
    auth: { action: 'view' },
    tags: ['discussions'],
    summary: 'Беседа объекта и последние сообщения',
    handler: async (request) => {
      const conversation = await DiscussionService.conversationFor(request.params.id)
      if (!conversation) return { conversation: null, items: [], nextCursor: null }
      const page = await DiscussionService.list(request.ctx, conversation.id, request.query)
      const unreadCount = await DiscussionService.unreadCount(request.ctx, conversation.id)
      return { conversation: { ...conversation, unreadCount }, ...page }
    },
  })

  route({
    route: 'POST /objects/:id/discussion/messages',
    auth: { action: 'comment' },
    tags: ['discussions'],
    summary: 'Написать в обсуждение объекта',
    handler: async (request) => {
      const result = await db().transaction(async (tx) => {
        const conversationId = await DiscussionService.ensureObjectConversation(
          tx,
          request.ctx,
          request.params.id,
        )
        const id = await DiscussionService.post(tx, request.ctx, conversationId, request.body)
        return { id: String(id), conversationId }
      })
      return result
    },
  })

  route({
    route: 'GET /conversations/:id/messages',
    auth: { action: 'view' },
    tags: ['discussions'],
    summary: 'Сообщения беседы',
    handler: async (request) =>
      DiscussionService.list(request.ctx, request.params.id, request.query),
  })

  route({
    route: 'POST /conversations/:id/messages',
    auth: { action: 'post' },
    tags: ['discussions'],
    summary: 'Отправить сообщение в беседу',
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        DiscussionService.post(tx, request.ctx, request.params.id, request.body),
      )
      return { id: String(id) }
    },
  })

  route({
    route: 'PATCH /messages/:messageId',
    auth: { delegated: 'DiscussionService.edit', resource: 'message' },
    tags: ['discussions'],
    summary: 'Изменить своё сообщение',
    handler: async (request) => {
      await db().transaction((tx) =>
        DiscussionService.edit(
          tx,
          request.ctx,
          Number(request.params.messageId),
          request.body.body,
          request.body.text,
        ),
      )
      return { ok: true }
    },
  })

  route({
    route: 'DELETE /messages/:messageId',
    auth: { delegated: 'DiscussionService.remove', resource: 'message' },
    tags: ['discussions'],
    summary: 'Удалить своё сообщение',
    handler: async (request) => {
      await db().transaction((tx) =>
        DiscussionService.remove(tx, request.ctx, Number(request.params.messageId)),
      )
      return { ok: true }
    },
  })

  route({
    route: 'PUT /messages/:messageId/reactions',
    auth: { delegated: 'authorize(post)', resource: 'message' },
    tags: ['discussions'],
    summary: 'Поставить или убрать реакцию',
    handler: async (request) => {
      const messageId = Number(request.params.messageId)
      const conversationId = await conversationOfMessage(messageId)
      await authorize(request.ctx, 'post', conversationId)
      await db().transaction((tx) =>
        DiscussionService.react(tx, request.ctx, messageId, request.body.emoji, request.body.on),
      )
      return { ok: true }
    },
  })

  route({
    route: 'POST /conversations/:id/read',
    auth: { action: 'view' },
    tags: ['discussions'],
    summary: 'Отметить сообщения прочитанными',
    handler: async (request) => {
      await DiscussionService.markRead(
        request.ctx,
        request.params.id,
        Number(request.body.messageId),
      )
      return { ok: true }
    },
  })
}

async function conversationOfMessage(messageId: number): Promise<string> {
  const [row] = await db()
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1)
  if (!row) throw errors.notFound('Сообщение')
  return row.conversationId
}
