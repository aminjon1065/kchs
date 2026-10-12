import { createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { atomFeed, publishedCap, rssFeed } from './domain/publication.js'
import { WarningService } from './domain/warning-service.js'

/** Ленты читают агрегаторы по расписанию: минута кэша и лимит на адрес. */
const PUBLIC_LIMIT = { max: 60, timeWindow: '1 minute' }

/**
 * Ответ ленты: тип, кэш на минуту и ETag — повторный запрос с `If-None-Match`
 * получает 304 без тела. Снаружи эти адреса открыты через шлюз DMZ (ADR-0200).
 */
function sendXml(
  request: FastifyRequest,
  reply: FastifyReply,
  body: string,
  contentType: string,
  lastModified: Date | null,
): string {
  const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`
  reply
    .header('content-type', `${contentType}; charset=utf-8`)
    .header('cache-control', 'public, max-age=60')
    .header('etag', etag)
    .header('x-content-type-options', 'nosniff')
    .header('access-control-allow-origin', '*')
  if (lastModified) reply.header('last-modified', lastModified.toUTCString())
  if (request.headers['if-none-match'] === etag) {
    reply.code(304)
    return ''
  }
  return body
}

/**
 * Предупреждения CAP 1.2 (ADR-0202): реестр и карточка для штаба, создание —
 * вручную и из сообщения об опасном явлении, отправка на решение, уточнение и
 * отмена; наружу — индекс Atom, сам CAP и RSS на трёх языках.
 */
export function registerWarningRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /warnings',
    auth: 'session',
    tags: ['warnings'],
    summary: 'Предупреждения: видимые смотрящему',
    handler: async (request) => WarningService.list(request.ctx, request.query),
  })

  route({
    route: 'GET /warnings/settings',
    auth: 'session',
    tags: ['warnings'],
    summary: 'Пространство предупреждений, реестр сообщений и адреса лент',
    handler: async () => WarningService.settings(),
  })

  route({
    route: 'GET /warnings/sources',
    auth: 'session',
    tags: ['warnings'],
    summary: 'Сообщения об опасных явлениях для черновика «из сообщения»',
    handler: async (request) => WarningService.sources(request.ctx, request.query),
  })

  route({
    route: 'POST /warnings',
    auth: 'session',
    tags: ['warnings'],
    summary: 'Создать черновик предупреждения',
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        WarningService.create(tx, request.ctx, request.body),
      )
      return { id }
    },
  })

  route({
    route: 'POST /warnings/from-message',
    auth: 'session',
    tags: ['warnings'],
    summary: 'Черновик предупреждения из сообщения об опасном явлении',
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        WarningService.fromMessage(tx, request.ctx, request.body),
      )
      return { id }
    },
  })

  route({
    route: 'GET /warnings/:id',
    auth: { action: 'view' },
    tags: ['warnings'],
    summary: 'Предупреждение: блоки по языкам, области, цепочка, маршрут',
    handler: async (request) => WarningService.get(request.ctx, request.params.id),
  })

  route({
    route: 'PUT /warnings/:id',
    auth: { action: 'edit' },
    tags: ['warnings'],
    summary: 'Изменить черновик предупреждения',
    handler: async (request) => {
      await db().transaction((tx) =>
        WarningService.update(tx, request.ctx, request.params.id, request.body),
      )
      return WarningService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'POST /warnings/:id/submit',
    auth: { action: 'edit' },
    tags: ['warnings'],
    summary: 'Отправить на решение уполномоченного лица (маршрут выпуска)',
    handler: async (request) => {
      const processId = await db().transaction((tx) =>
        WarningService.submit(tx, request.ctx, request.params.id),
      )
      return { processId }
    },
  })

  route({
    route: 'POST /warnings/:id/supersede',
    auth: { action: 'edit' },
    tags: ['warnings'],
    summary: 'Уточнить или отменить опубликованное — новым предупреждением',
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        WarningService.supersede(tx, request.ctx, request.params.id, request.body.msgType),
      )
      return { id }
    },
  })

  // ─── Наружу: без входа, через шлюз DMZ ────────────────────────────────────
  route({
    route: 'GET /public/cap/feed.xml',
    auth: 'public',
    tags: ['warnings'],
    summary: 'Индекс Atom действующих предупреждений',
    rateLimit: PUBLIC_LIMIT,
    handler: async (request, reply) =>
      sendXml(request, reply, await atomFeed(), 'application/atom+xml', null),
  })

  route({
    route: 'GET /public/cap/:id.xml',
    auth: 'public',
    tags: ['warnings'],
    summary: 'Предупреждение в формате CAP 1.2',
    rateLimit: PUBLIC_LIMIT,
    handler: async (request, reply) => {
      const cap = await publishedCap(request.params.id)
      if (!cap) throw errors.notFound('Предупреждение')
      return sendXml(request, reply, cap.xml, 'application/cap+xml', cap.sent)
    },
  })

  route({
    route: 'GET /public/cap/rss/:lang.xml',
    auth: 'public',
    tags: ['warnings'],
    summary: 'RSS действующих предупреждений на языке',
    rateLimit: PUBLIC_LIMIT,
    handler: async (request, reply) =>
      sendXml(request, reply, await rssFeed(request.params.lang), 'application/rss+xml', null),
  })
}
