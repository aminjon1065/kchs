import {
  Conversation,
  Message,
  MessageEditInput,
  MessageListQuery,
  MessagePostInput,
} from '@kchs/contracts'
import { z } from 'zod'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { authorize } from '../access/authorize.js'
import { DiscussionService } from './service.js'

const IdParam = z.object({ id: z.uuid() })

export function registerDiscussionRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/objects/:id/discussion',
    auth: { action: 'view' },
    tags: ['discussions'],
    summary: 'Беседа объекта и последние сообщения',
    schema: {
      params: IdParam,
      querystring: MessageListQuery,
      response: {
        200: z.object({
          conversation: Conversation.nullable(),
          items: z.array(Message),
          nextCursor: z.string().nullable(),
        }),
      },
    },
    handler: async (request) => {
      const conversation = await DiscussionService.conversationFor(request.params.id)
      if (!conversation) return { conversation: null, items: [], nextCursor: null }
      const page = await DiscussionService.list(request.ctx, conversation.id, request.query)
      const unreadCount = await DiscussionService.unreadCount(request.ctx, conversation.id)
      return { conversation: { ...conversation, unreadCount }, ...page }
    },
  })

  route({
    method: 'POST',
    url: '/objects/:id/discussion/messages',
    auth: { action: 'comment' },
    tags: ['discussions'],
    summary: 'Написать в обсуждение объекта',
    schema: {
      params: IdParam,
      body: MessagePostInput,
      response: { 200: z.object({ id: z.string(), conversationId: z.uuid() }) },
    },
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
    method: 'GET',
    url: '/conversations/:id/messages',
    auth: { action: 'view' },
    tags: ['discussions'],
    summary: 'Сообщения беседы',
    schema: {
      params: IdParam,
      querystring: MessageListQuery,
      response: { 200: z.object({ items: z.array(Message), nextCursor: z.string().nullable() }) },
    },
    handler: async (request) =>
      DiscussionService.list(request.ctx, request.params.id, request.query),
  })

  route({
    method: 'POST',
    url: '/conversations/:id/messages',
    auth: { action: 'post' },
    tags: ['discussions'],
    summary: 'Отправить сообщение в беседу',
    schema: {
      params: IdParam,
      body: MessagePostInput,
      response: { 200: z.object({ id: z.string() }) },
    },
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        DiscussionService.post(tx, request.ctx, request.params.id, request.body),
      )
      return { id: String(id) }
    },
  })

  route({
    method: 'PATCH',
    url: '/messages/:messageId',
    auth: 'session',
    tags: ['discussions'],
    summary: 'Изменить своё сообщение',
    schema: {
      params: z.object({ messageId: z.string() }),
      body: MessageEditInput,
      response: { 200: z.object({ ok: z.boolean() }) },
    },
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
    method: 'DELETE',
    url: '/messages/:messageId',
    auth: 'session',
    tags: ['discussions'],
    summary: 'Удалить своё сообщение',
    schema: {
      params: z.object({ messageId: z.string() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        DiscussionService.remove(tx, request.ctx, Number(request.params.messageId)),
      )
      return { ok: true }
    },
  })

  route({
    method: 'PUT',
    url: '/messages/:messageId/reactions',
    auth: 'session',
    tags: ['discussions'],
    summary: 'Поставить или убрать реакцию',
    schema: {
      params: z.object({ messageId: z.string() }),
      body: z.object({ emoji: z.string().max(16), on: z.boolean() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      const messageId = Number(request.params.messageId)
      const conversationId = await conversationOfMessage(messageId)
      await authorize(request.ctx, 'post', conversationId)
      await DiscussionService.react(request.ctx, messageId, request.body.emoji, request.body.on)
      return { ok: true }
    },
  })

  route({
    method: 'POST',
    url: '/conversations/:id/read',
    auth: { action: 'view' },
    tags: ['discussions'],
    summary: 'Отметить сообщения прочитанными',
    schema: {
      params: IdParam,
      body: z.object({ messageId: z.string() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
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
  const row = await db().query.messages.findFirst({
    where: (m, { eq }) => eq(m.id, messageId),
    columns: { conversationId: true },
  })
  if (!row) throw errors.notFound('Сообщение')
  return row.conversationId
}
