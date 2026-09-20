import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '~/shared/config/index.js'

/**
 * Ссылка для гостя (ADR-0091): подписанный токен `<встреча>.<срок>.<подпись>`
 * вместо записи в базе. Ссылка не даёт ни сессии, ни доступа к объектам — она
 * лишь называет встречу, в комнату гостя впускает организатор. Отзыв ссылки —
 * завершение встречи: токен без живой встречи бесполезен.
 */
const SEPARATOR = '.'

function key(): Buffer {
  // Тот же мастер-ключ установки, что у остальных секретов (17-security.md §4)
  return createHash('sha256').update(`meetings:guest-link:${config().KCHS_MASTER_KEY}`).digest()
}

function sign(payload: string): string {
  return createHmac('sha256', key()).update(payload).digest('base64url')
}

export interface GuestLink {
  token: string
  url: string
  expiresAt: string
}

export function createGuestLink(meetingId: string, ttlSeconds: number): GuestLink {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000)
  const payload = `${meetingId}${SEPARATOR}${Math.floor(expiresAt.getTime() / 1000)}`
  const token = `${payload}${SEPARATOR}${sign(payload)}`
  return {
    token,
    url: `${config().KCHS_BASE_URL}/meet/${token}`,
    expiresAt: expiresAt.toISOString(),
  }
}

/** Разбор токена: подпись и срок; идентификатор встречи проверяет вызывающий. */
export function readGuestLink(token: string): { meetingId: string; expiresAt: string } | null {
  const parts = token.split(SEPARATOR)
  if (parts.length !== 3) return null
  const [meetingId, expires, signature] = parts as [string, string, string]
  const expected = sign(`${meetingId}${SEPARATOR}${expires}`)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const expiresAt = Number(expires)
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 <= Date.now()) return null
  return { meetingId, expiresAt: new Date(expiresAt * 1000).toISOString() }
}
