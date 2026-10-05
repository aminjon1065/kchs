import type { RouteRegistrar } from '~/shared/http/route.js'
import { Assistant } from './domain/assistant.js'

/**
 * Ассистент (13-search-knowledge-ai.md §5, ADR-0100, ADR-0181): диалог по объекту,
 * инструменты над поиском, данными и файлами выполняются правами спрашивающего.
 * Модель — через шлюз `ai`; выключает ассистента возможность «ИИ» того же модуля.
 */
export function registerAssistantRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /assistant/thread',
    auth: 'session',
    tags: ['ai'],
    summary: 'Диалог с ассистентом по объекту — только свой (ADR-0100)',
    handler: async (request) => Assistant.thread(request.ctx, request.query.objectId ?? null),
  })

  route({
    route: 'POST /assistant/ask',
    auth: 'session',
    tags: ['ai'],
    summary: 'Вопрос ассистенту: инструменты выполняются правами спрашивающего',
    handler: async (request) =>
      Assistant.ask(request.ctx, {
        objectId: request.body.objectId,
        question: request.body.question,
      }),
  })

  route({
    route: 'DELETE /assistant/threads/:id',
    auth: { owned: 'Assistant.clear — только свой разговор с помощником' },
    tags: ['ai'],
    summary: 'Стереть свой диалог с ассистентом',
    handler: async (request) => {
      await Assistant.clear(request.ctx, request.params.id)
      return { ok: true as const }
    },
  })
}
