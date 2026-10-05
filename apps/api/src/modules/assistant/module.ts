import {
  AssistantAskInput,
  AssistantMessage,
  AssistantThread,
  AssistantThreadQuery,
} from '@kchs/contracts'
import { z } from 'zod'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { Assistant } from './domain/assistant.js'

/**
 * Ассистент (13-search-knowledge-ai.md §5, ADR-0100, ADR-0181): диалог по объекту,
 * инструменты над поиском, данными и файлами выполняются правами спрашивающего.
 * Модель — через шлюз `ai`; выключает ассистента возможность «ИИ» того же модуля.
 */
export function registerAssistantRoutes(route: RouteRegistrar): void {
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
    auth: { owned: 'Assistant.clear — только свой разговор с помощником' },
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
