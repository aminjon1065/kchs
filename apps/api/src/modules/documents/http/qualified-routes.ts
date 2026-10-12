import type { FastifyReply } from 'fastify'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { renderSigningPage } from '../domain/qes-page.js'
import { QualifiedSignatures } from '../domain/routes/qualified.js'

/** Ответы страницы подписания и её маршрутов: не кэшировать, не встраивать, без Referer. */
function noStore(reply: FastifyReply): void {
  reply
    .header('cache-control', 'no-store')
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
}

/**
 * Квалифицированная электронная подпись (ADR-0205): сеанс подписания из карточки,
 * страница подписания со своей CSP, её маршруты по билету, повторная проверка и
 * обратные вызовы движка.
 */
export function registerQualifiedSignatureRoutes(route: RouteRegistrar): void {
  route({
    route: 'POST /documents/:id/qes-sessions',
    auth: { delegated: 'QualifiedSignatures.start', objectType: 'document' },
    tags: ['signing'],
    summary: 'Начать подписание квалифицированной подписью: ссылка на страницу подписания',
    handler: async (request) =>
      QualifiedSignatures.start(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'GET /documents/:id/qes-sessions/:sessionId',
    auth: { delegated: 'QualifiedSignatures.get', objectType: 'document' },
    tags: ['signing'],
    summary: 'Состояние сеанса квалифицированной подписи',
    handler: async (request) =>
      QualifiedSignatures.get(request.ctx, request.params.id, request.params.sessionId),
  })

  route({
    route: 'POST /documents/:id/signatures/:signatureId/verify',
    auth: { delegated: 'QualifiedSignatures.verify', objectType: 'document' },
    tags: ['signing'],
    summary: 'Проверить квалифицированную подпись заново: цепочка, отзыв, штамп времени',
    handler: async (request) => {
      await QualifiedSignatures.verify(request.ctx, request.params.id, request.params.signatureId)
      return { queued: true as const }
    },
  })

  // Страница — только вошедшему подписанту этого сеанса (билет и сессия совпадают)
  route({
    route: 'GET /qes/sessions/:id/page',
    auth: { owned: 'renderSigningPage — сеанс подписания вошедшего, билет на него же' },
    tags: ['signing'],
    summary: 'Страница подписания: агент УЦ подписывает хэш документа',
    handler: async (request, reply) => {
      const page = await renderSigningPage(request.ctx, request.params.id, request.query.t)
      noStore(reply)
      reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('x-frame-options', 'DENY')
        .header('content-security-policy', page.csp)
      return page.body
    },
  })

  // Маршруты страницы: билет в адресе — единственный допуск, cookie не нужны
  const ticketLimit = { max: 120, timeWindow: '1 minute' }
  route({
    route: 'GET /qes/sessions/:id/state',
    auth: 'public',
    tags: ['signing'],
    summary: 'Страница подписания: состояние сеанса и хэш для агента',
    rateLimit: ticketLimit,
    handler: async (request, reply) => {
      noStore(reply)
      return QualifiedSignatures.pageState(request.params.id, request.query.t)
    },
  })

  route({
    route: 'POST /qes/sessions/:id/certificate',
    auth: 'public',
    tags: ['signing'],
    summary: 'Страница подписания: сертификат, выбранный в агенте УЦ',
    rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async (request, reply) => {
      noStore(reply)
      return QualifiedSignatures.submitCertificate(
        request.params.id,
        request.query.t,
        request.body.certificate,
      )
    },
  })

  route({
    route: 'POST /qes/sessions/:id/result',
    auth: 'public',
    tags: ['signing'],
    summary: 'Страница подписания: CMS от агента УЦ — встроить и проверить',
    rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async (request, reply) => {
      noStore(reply)
      return QualifiedSignatures.submitCms(request.params.id, request.query.t, request.body.cms)
    },
  })

  // ─── Движок (токен задания, внутренняя сеть, ADR-0176) ─────────────────────

  route({
    route: 'POST /internal/documents/signature-sessions/:id/start',
    auth: { engineJob: { scope: (params) => `signature-session:${params.id}` } },
    tags: ['internal'],
    summary: 'Движок начинает шаг подписи: план по состоянию сеанса',
    handler: async (request) =>
      QualifiedSignatures.engineStart(request.params.id, request.body.step),
  })

  route({
    route: 'POST /internal/documents/signature-sessions/:id/done',
    auth: { engineJob: { scope: (params) => `signature-session:${params.id}` } },
    tags: ['internal'],
    summary: 'Движок закончил шаг подписи: подготовка, встраивание или проверка',
    handler: async (request) => {
      const { stale } = await QualifiedSignatures.engineDone(request.params.id, request.body)
      return { ok: true, stale }
    },
  })
}
