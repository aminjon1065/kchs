import { createHmac, timingSafeEqual } from 'node:crypto'
import { signingKeys } from './secrets.js'

/**
 * Токен обратного вызова задания движка (ADR-0176). api выдаёт его заданию при
 * передаче в очередь, движок присылает его в заголовке `x-kchs-job-token`.
 * Подпись — ключом из мастер-ключа, которого у движка нет: токен не подделать и
 * не переписать на другое задание. Он открывает маршруты только своего задания
 * (`jobId`) и его ресурса (`scope`, например `file:<id>`) и только до срока.
 */
const PURPOSE = 'kchs:engine-job-token:v1'
const VERSION = 'v1'

export const JOB_TOKEN_HEADER = 'x-kchs-job-token'
/**
 * Срок токена. Повторы BullMQ идут с тем же токеном, повторная передача из
 * реестра выдаёт новый — запаса хватает на очередь, работу и повторы.
 */
export const JOB_TOKEN_TTL_MS = 72 * 3600_000

export interface JobTokenClaims {
  jobId: string
  /** Ресурс задания; пусто — только статус самого задания. */
  scope: string
  expiresAt: number
}

export function issueJobToken(
  input: { jobId: string; scope?: string | null },
  now = Date.now(),
): string {
  const [key] = signingKeys(PURPOSE)
  if (!key) throw new Error('KCHS_MASTER_KEY не задан: токен задания подписать нечем')
  const payload = Buffer.from(
    JSON.stringify({
      j: input.jobId,
      s: input.scope ?? '',
      e: Math.floor((now + JOB_TOKEN_TTL_MS) / 1000),
    }),
  ).toString('base64url')
  return `${VERSION}.${payload}.${sign(key, payload)}`
}

/** Утверждения токена, если он подписан нашим ключом и не истёк; иначе `null`. */
export function verifyJobToken(token: unknown, now = Date.now()): JobTokenClaims | null {
  if (typeof token !== 'string') return null
  const [version, payload, signature, ...rest] = token.split('.')
  if (version !== VERSION || !payload || !signature || rest.length > 0) return null
  const provided = Buffer.from(signature, 'base64url')
  // Текущим и прежним ключом: смена мастер-ключа не обрывает задания в работе
  const signed = signingKeys(PURPOSE).some((key) => {
    const expected = Buffer.from(sign(key, payload), 'base64url')
    return expected.length === provided.length && timingSafeEqual(expected, provided)
  })
  if (!signed) return null
  let claims: { j?: unknown; s?: unknown; e?: unknown }
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof claims.j !== 'string' || typeof claims.s !== 'string') return null
  if (typeof claims.e !== 'number' || claims.e * 1000 < now) return null
  return { jobId: claims.j, scope: claims.s, expiresAt: claims.e * 1000 }
}

function sign(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(`${VERSION}.${payload}`, 'utf8').digest('base64url')
}
