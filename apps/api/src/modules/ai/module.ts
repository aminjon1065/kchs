import {
  AiStatus,
  AssistantAskInput,
  AssistantMessage,
  AssistantThread,
  AssistantThreadQuery,
} from '@kchs/contracts'
import { z } from 'zod'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { Assistant } from './domain/assistant.js'
import { AiService } from './domain/service.js'

export function registerAiRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/ai/status',
    auth: 'session',
    tags: ['ai'],
    summary: 'ИИ: включён ли для пользователя, провайдер и суточные лимиты',
    schema: { response: { 200: AiStatus } },
    handler: async (request) => AiService.status(request.ctx),
  })

  route({
    method: 'GET',
    url: '/assistant/thread',
    auth: 'session',
    tags: ['ai'],
    summary: 'Диалог с ассистентом по объекту — только свой (ADR-0100)',
    schema: { querystring: AssistantThreadQuery, response: { 200: AssistantThread } },
    handler: async (request) => Assistant.thread(request.ctx, request.query.objectId ?? null),
  })

  route({
    method: 'POST',
    url: '/assistant/ask',
    auth: 'session',
    tags: ['ai'],
    summary: 'Вопрос ассистенту: инструменты выполняются правами спрашивающего',
    schema: { body: AssistantAskInput, response: { 200: AssistantMessage } },
    handler: async (request) =>
      Assistant.ask(request.ctx, {
        objectId: request.body.objectId,
        question: request.body.question,
      }),
  })

  route({
    method: 'DELETE',
    url: '/assistant/threads/:id',
    auth: 'session',
    tags: ['ai'],
    summary: 'Стереть свой диалог с ассистентом',
    schema: {
      params: z.object({ id: z.uuid() }),
      response: { 200: z.object({ ok: z.literal(true) }) },
    },
    handler: async (request) => {
      await Assistant.clear(request.ctx, request.params.id)
      return { ok: true as const }
    },
  })
}
