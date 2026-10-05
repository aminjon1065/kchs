import type { RouteRegistrar } from '~/shared/http/route.js'
import { DocumentAssistService } from '../domain/assist-service.js'

/**
 * ИИ в документах (ADR-0088): состояние помощи, реквизиты из скана,
 * краткое содержание и черновик ответа. Права — `authorize` ядра, гриф —
 * порог установки, лимиты и аудит — модуль ИИ.
 */
export function registerDocumentAssistRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /documents/:id/assist',
    auth: { delegated: 'DocumentAssistService.status', objectType: 'document' },
    tags: ['documents'],
    summary: 'Доступна ли помощь ИИ по документу и почему нет',
    handler: async (request) => DocumentAssistService.status(request.ctx, request.params.id),
  })

  route({
    route: 'POST /documents/:id/assist/extract',
    auth: { delegated: 'DocumentAssistService.extract', objectType: 'document' },
    tags: ['documents'],
    summary: 'Реквизиты из текста скана — предложения с уверенностью',
    readOnly: true,
    handler: async (request) => DocumentAssistService.extract(request.ctx, request.params.id),
  })

  route({
    route: 'POST /documents/:id/assist/classify',
    auth: { delegated: 'DocumentAssistService.classify', objectType: 'document' },
    tags: ['documents'],
    summary: 'Вид документа по тексту скана и похожие документы',
    description: 'Предложение с уверенностью и цитатой: вид выбирается из заведённых в установке.',
    readOnly: true,
    handler: async (request) => DocumentAssistService.classify(request.ctx, request.params.id),
  })

  route({
    route: 'POST /documents/:id/assist/summary',
    auth: { delegated: 'DocumentAssistService.summary', objectType: 'document' },
    tags: ['documents'],
    summary: 'Краткое содержание документа',
    readOnly: true,
    handler: async (request) => DocumentAssistService.summary(request.ctx, request.params.id),
  })

  route({
    route: 'POST /documents/:id/assist/reply',
    auth: { delegated: 'DocumentAssistService.reply', objectType: 'document' },
    tags: ['documents'],
    summary: 'Черновик ответа на входящее',
    readOnly: true,
    handler: async (request) =>
      DocumentAssistService.reply(request.ctx, request.params.id, request.body),
  })
}
