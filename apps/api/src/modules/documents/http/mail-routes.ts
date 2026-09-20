import {
  MailMessageList,
  MailMessageListQuery,
  MailMessageRecord,
  MailPollReport,
  MailRejectInput,
} from '@kchs/contracts'
import { z } from 'zod'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { MailIntake } from '../domain/mail/mail-service.js'

const IdParam = z.object({ id: z.uuid() })

/**
 * Очередь «Из почты» (08-documents.md §5, ADR-0113). Письма ящика канцелярии
 * видит делопроизводитель: способность `documents.register` — та же, что у
 * регистрации. Сам черновик открывается обычной карточкой документа, поэтому
 * отдельных маршрутов «зарегистрировать» здесь нет — регистрация идёт
 * существующим мастером.
 */
export function registerMailRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/documents/mail',
    auth: { capability: 'documents.register' },
    tags: ['documents'],
    summary: 'Очередь писем из ящика канцелярии',
    schema: { querystring: MailMessageListQuery, response: { 200: MailMessageList } },
    handler: async (request) => MailIntake.list(request.ctx, request.query),
  })

  route({
    method: 'GET',
    url: '/documents/mail/:id',
    auth: { capability: 'documents.register' },
    tags: ['documents'],
    summary: 'Письмо очереди: заголовки, текст, вложения',
    schema: { params: IdParam, response: { 200: MailMessageRecord } },
    handler: async (request) => MailIntake.get(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/documents/mail/:id/reject',
    auth: { capability: 'documents.register' },
    tags: ['documents'],
    summary: 'Отклонить письмо с причиной',
    schema: { params: IdParam, body: MailRejectInput, response: { 200: MailMessageRecord } },
    handler: async (request) =>
      MailIntake.reject(request.ctx, request.params.id, request.body.reason),
  })

  route({
    method: 'POST',
    url: '/documents/mail/poll',
    auth: { capability: 'documents.register' },
    tags: ['documents'],
    summary: 'Получить почту сейчас, не дожидаясь расписания',
    schema: {
      querystring: z.object({ integrationId: z.uuid().optional() }),
      response: { 200: MailPollReport },
    },
    rateLimit: { max: 10, timeWindow: '1 minute' },
    handler: async (request) =>
      MailIntake.poll({
        force: true,
        ...(request.query.integrationId ? { integrationId: request.query.integrationId } : {}),
      }),
  })
}
