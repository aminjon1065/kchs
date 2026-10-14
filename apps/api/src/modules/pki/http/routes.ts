import type { FastifyReply } from 'fastify'
import { requireCapability } from '~/kernel/access/authorize.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { PkiAuthority } from '../domain/authority.js'
import { PkiCertificates } from '../domain/certificates.js'

/** Запросов OCSP и штампов времени в минуту с одного адреса. */
const STATUS_PER_MINUTE = 120

function sendDer(reply: FastifyReply, contentType: string, der: Buffer, maxAge: number): Buffer {
  reply
    .header('content-type', contentType)
    .header('cache-control', maxAge > 0 ? `public, max-age=${maxAge}` : 'no-store')
    .header('x-content-type-options', 'nosniff')
  return der
}

function binaryBody(body: unknown): Buffer {
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > 64 * 1024) {
    throw errors.validation('Ожидается запрос в DER', [
      { path: 'body', message: 'пусто или слишком велик' },
    ])
  }
  return body
}

/**
 * УЦ Комитета (ADR-0218): сертификаты УЦ, списки отзыва и ответчик OCSP — без входа (их
 * спрашивают программы чтения PDF, проверяя подпись), служба штампов времени — для движка
 * внутри сети; выпуск и отзыв сертификатов — сотрудником в своей сессии и администратором.
 */
export function registerPkiRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /pki/status',
    auth: 'session',
    tags: ['pki'],
    summary: 'Состояние УЦ Комитета',
    handler: async () => PkiAuthority.status(),
  })

  for (const [path, kind] of [
    ['GET /pki/root.crt', 'root'],
    ['GET /pki/issuing.crt', 'issuing'],
  ] as const) {
    route({
      route: path,
      auth: 'public',
      tags: ['pki'],
      summary:
        kind === 'root'
          ? 'Корневой сертификат УЦ Комитета (установить в доверенные)'
          : 'Сертификат выпускающего УЦ Комитета',
      rateLimit: { max: 60, timeWindow: '1 minute' },
      handler: async (_request, reply) => {
        // `issuing.crt` — первый выпускающий: его адрес вшит в выпущенные им сертификаты
        const der =
          kind === 'root'
            ? (await PkiAuthority.required('root')).certificateDer
            : await PkiAuthority.issuerCertificate('issuing')
        reply.header('content-disposition', `attachment; filename="kchs-${kind}-ca.crt"`)
        return sendDer(reply, 'application/pkix-cert', der, 3600)
      },
    })
  }

  // Выпускающие после смены ключа (ADR-0224): у каждого свои адреса сертификата и списка
  route({
    route: 'GET /pki/issuers/:generation.crt',
    auth: 'public',
    tags: ['pki'],
    summary: 'Сертификат выпускающего УЦ Комитета после смены ключа',
    rateLimit: { max: 60, timeWindow: '1 minute' },
    handler: async (request, reply) => {
      const der = await PkiAuthority.issuerCertificate(`issuers/${request.params.generation}`)
      reply.header('content-disposition', 'attachment; filename="kchs-issuing-ca.crt"')
      return sendDer(reply, 'application/pkix-cert', der, 3600)
    },
  })

  route({
    route: 'GET /pki/issuers/:generation.crl',
    auth: 'public',
    tags: ['pki'],
    summary: 'Список отзыва выпускающего УЦ Комитета после смены ключа',
    rateLimit: { max: STATUS_PER_MINUTE, timeWindow: '1 minute' },
    handler: async (request, reply) =>
      sendDer(
        reply,
        'application/pkix-crl',
        await PkiAuthority.crl(`issuers/${request.params.generation}`),
        300,
      ),
  })

  for (const [path, kind] of [
    ['GET /pki/root.crl', 'root'],
    ['GET /pki/issuing.crl', 'issuing'],
  ] as const) {
    route({
      route: path,
      auth: 'public',
      tags: ['pki'],
      summary: 'Список отзыва сертификатов УЦ Комитета',
      rateLimit: { max: STATUS_PER_MINUTE, timeWindow: '1 minute' },
      handler: async (_request, reply) =>
        sendDer(reply, 'application/pkix-crl', await PkiAuthority.crl(kind), 300),
    })
  }

  route({
    route: 'POST /pki/ocsp',
    auth: 'public',
    tags: ['pki'],
    summary: 'Ответчик OCSP УЦ Комитета (RFC 6960)',
    rateLimit: { max: STATUS_PER_MINUTE, timeWindow: '1 minute' },
    handler: async (request, reply) =>
      sendDer(
        reply,
        'application/ocsp-response',
        await PkiAuthority.ocsp(binaryBody(request.body)),
        0,
      ),
  })

  route({
    route: 'GET /pki/ocsp/:request',
    auth: 'public',
    tags: ['pki'],
    summary: 'Ответчик OCSP УЦ Комитета — запрос в адресе (base64)',
    rateLimit: { max: STATUS_PER_MINUTE, timeWindow: '1 minute' },
    handler: async (request, reply) =>
      sendDer(
        reply,
        'application/ocsp-response',
        await PkiAuthority.ocsp(Buffer.from(decodeURIComponent(request.params.request), 'base64')),
        0,
      ),
  })

  route({
    route: 'POST /pki/tsa',
    auth: 'public',
    tags: ['pki'],
    summary: 'Служба штампов времени УЦ Комитета (RFC 3161) — для движка внутри сети',
    rateLimit: { max: STATUS_PER_MINUTE, timeWindow: '1 minute' },
    handler: async (request, reply) =>
      sendDer(
        reply,
        'application/timestamp-reply',
        await PkiAuthority.timestamp(binaryBody(request.body)),
        0,
      ),
  })

  route({
    route: 'POST /me/certificates/challenge',
    auth: 'session',
    tags: ['pki'],
    summary: 'Вызов для доказательства владения ключом устройства',
    handler: async (request) => PkiCertificates.challenge(request.ctx, request.body.purpose),
  })

  route({
    route: 'POST /me/certificates',
    auth: 'session',
    tags: ['pki'],
    summary: 'Выпустить сертификат на ключ этого устройства (второй фактор)',
    rateLimit: { max: 10, timeWindow: '1 minute' },
    handler: async (request) => PkiCertificates.enroll(request.ctx, request.body),
  })

  route({
    route: 'GET /me/certificates',
    auth: 'session',
    tags: ['pki'],
    summary: 'Мои сертификаты подписи и печати',
    handler: async (request) => PkiCertificates.mine(request.ctx),
  })

  route({
    route: 'POST /me/certificates/:id/revoke',
    auth: { owned: 'PkiCertificates.revokeMine ищет сертификат среди своих' },
    tags: ['pki'],
    summary: 'Отозвать свой сертификат (ключ утерян, устройство сменилось)',
    handler: async (request) =>
      PkiCertificates.revokeMine(request.ctx, request.params.id, request.body.reason ?? null),
  })

  route({
    route: 'POST /admin/pki/init',
    auth: 'session',
    tags: ['pki'],
    summary: 'Создать УЦ Комитета (один раз)',
    handler: async (request) => {
      requireCapability(request.ctx, 'admin.system')
      return PkiAuthority.initialize(request.ctx)
    },
  })

  route({
    route: 'POST /admin/pki/rotate',
    auth: 'session',
    tags: ['pki'],
    summary: 'Сменить ключ выпускающего УЦ Комитета: плановая смена или компрометация',
    handler: async (request) => {
      requireCapability(request.ctx, 'admin.system')
      return PkiAuthority.rotate(request.ctx, request.body)
    },
  })

  route({
    route: 'GET /admin/pki/certificates',
    auth: 'session',
    tags: ['pki'],
    summary: 'Сертификаты сотрудников и печати',
    handler: async (request) => PkiCertificates.list(request.ctx, request.query),
  })

  route({
    route: 'POST /admin/pki/certificates/:id/revoke',
    auth: {
      delegated: 'PkiCertificates.revoke требует способность users.manage',
      resource: 'pki-certificate',
    },
    tags: ['pki'],
    summary: 'Отозвать сертификат сотрудника',
    handler: async (request) =>
      PkiCertificates.revoke(request.ctx, request.params.id, request.body.reason ?? null),
  })
}
