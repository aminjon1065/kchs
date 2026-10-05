import type { RouteRegistrar } from '~/shared/http/route.js'
import { MailIntake } from '../domain/mail/mail-service.js'

/**
 * Очередь «Из почты» (08-documents.md §5, ADR-0113). Письма ящика канцелярии
 * видит делопроизводитель: способность `documents.register` — та же, что у
 * регистрации. Сам черновик открывается обычной карточкой документа, поэтому
 * отдельных маршрутов «зарегистрировать» здесь нет — регистрация идёт
 * существующим мастером.
 */
export function registerMailRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /documents/mail',
    auth: { capability: 'documents.register' },
    tags: ['documents'],
    summary: 'Очередь писем из ящика канцелярии',
    handler: async (request) => MailIntake.list(request.ctx, request.query),
  })

  route({
    route: 'GET /documents/mail/:id',
    auth: { capability: 'documents.register' },
    tags: ['documents'],
    summary: 'Письмо очереди: заголовки, текст, вложения',
    handler: async (request) => MailIntake.get(request.ctx, request.params.id),
  })

  route({
    route: 'POST /documents/mail/:id/reject',
    auth: { capability: 'documents.register' },
    tags: ['documents'],
    summary: 'Отклонить письмо с причиной',
    handler: async (request) =>
      MailIntake.reject(request.ctx, request.params.id, request.body.reason),
  })

  route({
    route: 'POST /documents/mail/poll',
    auth: { capability: 'documents.register' },
    tags: ['documents'],
    summary: 'Получить почту сейчас, не дожидаясь расписания',
    rateLimit: { max: 10, timeWindow: '1 minute' },
    handler: async (request) =>
      MailIntake.poll({
        force: true,
        ...(request.query.integrationId ? { integrationId: request.query.integrationId } : {}),
      }),
  })
}
