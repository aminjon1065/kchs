import { z } from 'zod'
import {
  Conversation,
  Message,
  MessageEditInput,
  MessageListQuery,
  MessagePostInput,
} from '../../discussions/message.js'
import { defineRoutes } from '../../http/route-contract.js'
import { IdParam } from '../params.js'

/**
 * Маршруты ядра «discussions» (ADR-0188). Регистрация — `apps/api/src/kernel/discussions/`:
 * http.ts.
 */
export const kernelDiscussionsRoutes = defineRoutes({
  'GET /objects/:id/discussion': {
    params: IdParam,
    query: MessageListQuery,
    response: {
      200: z.object({
        conversation: Conversation.nullable(),
        items: z.array(Message),
        nextCursor: z.string().nullable(),
      }),
    },
  },
  'POST /objects/:id/discussion/messages': {
    params: IdParam,
    body: MessagePostInput,
    response: { 200: z.object({ id: z.string(), conversationId: z.uuid() }) },
  },
  'GET /conversations/:id/messages': {
    params: IdParam,
    query: MessageListQuery,
    response: { 200: z.object({ items: z.array(Message), nextCursor: z.string().nullable() }) },
  },
  'POST /conversations/:id/messages': {
    params: IdParam,
    body: MessagePostInput,
    response: { 200: z.object({ id: z.string() }) },
  },
  'PATCH /messages/:messageId': {
    params: z.object({ messageId: z.string() }),
    body: MessageEditInput,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'DELETE /messages/:messageId': {
    params: z.object({ messageId: z.string() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'PUT /messages/:messageId/reactions': {
    params: z.object({ messageId: z.string() }),
    body: z.object({ emoji: z.string().max(16), on: z.boolean() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'POST /conversations/:id/read': {
    params: IdParam,
    body: z.object({ messageId: z.string() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
})
