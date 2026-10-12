import { createHmac, timingSafeEqual } from 'node:crypto'
import { signingKeys } from '~/shared/crypto/secrets.js'

/**
 * Билет страницы подписания (ADR-0205): подписанный адрес, по которому страница
 * отдаёт сертификат и CMS агента и спрашивает состояние сеанса. Подпись — ключом из
 * мастер-ключа (ADR-0143: принимается и прежний), билет открывает только свой сеанс
 * и только того, кто подписывает, до срока. Страница живёт без SPA и без cookie-запросов:
 * билет — единственный способ дойти до маршрутов результата.
 */
const PURPOSE = 'kchs:qes-signing-ticket:v1'
const VERSION = 'q1'

export interface SigningTicketClaims {
  sessionId: string
  userId: string
  expiresAt: number
}

function sign(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(`${VERSION}.${payload}`, 'utf8').digest('base64url')
}

export function issueSigningTicket(claims: SigningTicketClaims): string {
  const [key] = signingKeys(PURPOSE)
  if (!key) throw new Error('KCHS_MASTER_KEY не задан: билет подписания подписать нечем')
  const payload = Buffer.from(
    JSON.stringify({
      s: claims.sessionId,
      u: claims.userId,
      e: Math.floor(claims.expiresAt / 1000),
    }),
  ).toString('base64url')
  return `${VERSION}.${payload}.${sign(key, payload)}`
}

/** Утверждения билета для этого сеанса, если подпись верна и срок не вышел; иначе `null`. */
export function verifySigningTicket(
  ticket: unknown,
  sessionId: string,
  now = Date.now(),
): SigningTicketClaims | null {
  if (typeof ticket !== 'string' || ticket.length > 1024) return null
  const [version, payload, signature, ...rest] = ticket.split('.')
  if (version !== VERSION || !payload || !signature || rest.length > 0) return null
  const provided = Buffer.from(signature, 'base64url')
  const signed = signingKeys(PURPOSE).some((key) => {
    const expected = Buffer.from(sign(key, payload), 'base64url')
    return expected.length === provided.length && timingSafeEqual(expected, provided)
  })
  if (!signed) return null
  let claims: { s?: unknown; u?: unknown; e?: unknown }
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof claims.s !== 'string' || typeof claims.u !== 'string') return null
  if (claims.s !== sessionId) return null
  if (typeof claims.e !== 'number' || claims.e * 1000 < now) return null
  return { sessionId: claims.s, userId: claims.u, expiresAt: claims.e * 1000 }
}
