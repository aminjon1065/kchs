import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { DocumentSignatures } from '../domain/routes/signatures.js'
import { renderVerifyPage } from '../domain/verify-page.js'

/**
 * Подпись как реквизит (ADR-0198): место факсимиле на подписанном экземпляре и
 * публичная страница проверки по QR-коду штампа.
 */
export function registerSignatureRoutes(route: RouteRegistrar): void {
  route({
    route: 'PUT /documents/:id/signatures/:signatureId/placement',
    auth: { delegated: 'DocumentSignatures.place', objectType: 'document' },
    tags: ['documents'],
    summary: 'Поправить место факсимиле на подписанном экземпляре',
    handler: async (request) => {
      await db().transaction((tx) =>
        DocumentSignatures.place(
          tx,
          request.ctx,
          request.params.id,
          request.params.signatureId,
          request.body,
        ),
      )
      const items = await DocumentSignatures.list(request.ctx, request.params.id)
      const signature = items.find((item) => item.id === request.params.signatureId)
      if (!signature) throw new Error('подпись пропала после записи места')
      return signature
    },
  })

  // Без входа: QR на бумаге читают и вне Комитета. Страница — только состояние и
  // реквизиты подписи, без содержания документа; частота ограничена
  route({
    route: 'GET /verify/:id',
    auth: 'public',
    tags: ['documents'],
    summary: 'Страница проверки подписи по QR-коду штампа',
    rateLimit: { max: 30, timeWindow: '1 minute' },
    handler: async (request, reply) => {
      const page = await renderVerifyPage(request.params.id, request.headers['accept-language'])
      reply
        .code(page.status)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .header('x-frame-options', 'DENY')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .header(
          'content-security-policy',
          [
            "default-src 'none'",
            `style-src 'nonce-${page.nonce}'`,
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
          ].join('; '),
        )
      return page.body
    },
  })
}
