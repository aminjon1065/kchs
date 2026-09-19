import {
  DocumentAssistStatus,
  DocumentExtraction,
  DocumentReplyDraft,
  DocumentReplyDraftInput,
  DocumentSummaryDraft,
} from '@kchs/contracts'
import { z } from 'zod'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { DocumentAssistService } from '../domain/assist-service.js'

const IdParam = z.object({ id: z.uuid() })

/**
 * ИИ в документах (ADR-0088): состояние помощи, реквизиты из скана,
 * краткое содержание и черновик ответа. Права — `authorize` ядра, гриф —
 * порог установки, лимиты и аудит — модуль ИИ.
 */
export function registerDocumentAssistRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/documents/:id/assist',
    auth: 'session',
    tags: ['documents'],
    summary: 'Доступна ли помощь ИИ по документу и почему нет',
    schema: { params: IdParam, response: { 200: DocumentAssistStatus } },
    handler: async (request) => DocumentAssistService.status(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/documents/:id/assist/extract',
    auth: 'session',
    tags: ['documents'],
    summary: 'Реквизиты из текста скана — предложения с уверенностью',
    readOnly: true,
    schema: { params: IdParam, response: { 200: DocumentExtraction } },
    handler: async (request) => DocumentAssistService.extract(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/documents/:id/assist/summary',
    auth: 'session',
    tags: ['documents'],
    summary: 'Краткое содержание документа',
    readOnly: true,
    schema: { params: IdParam, response: { 200: DocumentSummaryDraft } },
    handler: async (request) => DocumentAssistService.summary(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/documents/:id/assist/reply',
    auth: 'session',
    tags: ['documents'],
    summary: 'Черновик ответа на входящее',
    readOnly: true,
    schema: {
      params: IdParam,
      body: DocumentReplyDraftInput,
      response: { 200: DocumentReplyDraft },
    },
    handler: async (request) =>
      DocumentAssistService.reply(request.ctx, request.params.id, request.body),
  })
}
