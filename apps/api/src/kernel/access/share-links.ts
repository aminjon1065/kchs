import {
  GUEST_CLEARANCE,
  levelValue,
  type ShareLinkInput,
  type ShareLinkOpenResult,
  withinClearance,
} from '@kchs/contracts'
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { config } from '~/shared/config/index.js'
import { EMPTY_PRINCIPALS, type UserCtx } from '~/shared/context.js'
import { hashPassword, verifyPassword } from '~/shared/crypto/password.js'
import { hashToken } from '~/shared/crypto/secrets.js'
import { db, type Executor } from '~/shared/db/client.js'
import { shareLinks } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId, randomToken } from '~/shared/ids.js'
import { cacheKeys, redis } from '~/shared/redis/index.js'
import { SecurityPolicyService } from '../settings/security-policy.js'
import { effectiveConfidentiality } from './confidentiality.js'

/**
 * Гостевые ссылки (03-access-model.md §Гостевые ссылки):
 * доступ только к конкретному объекту, без входа, с аудитом открытий.
 */
export async function createShareLink(
  tx: Executor,
  ctx: UserCtx,
  objectId: string,
  input: ShareLinkInput,
): Promise<{ id: string; token: string; url: string }> {
  await assertShareLinksAllowed()
  // Гость видит только общедоступное: ссылка на объект с грифом не откроется (ADR-0080)
  if (!withinClearance(await effectiveConfidentiality(objectId, tx), GUEST_CLEARANCE)) {
    throw errors.policyViolation('Гостевая ссылка на объект с грифом недоступна', {
      reason: 'confidential_object',
    })
  }
  const token = randomToken(24)
  const id = newId()
  await tx.insert(shareLinks).values({
    id,
    objectId,
    token: hashToken(token),
    level: levelValue('view'),
    passwordHash: input.password ? await hashPassword(input.password) : null,
    expiresAt: input.expiresAt ?? null,
    maxUses: input.maxUses ?? null,
    includeAttachments: input.includeAttachments,
    createdBy: ctx.userId,
  })
  return { id, token, url: `${config().KCHS_BASE_URL}/s/${token}` }
}

export async function revokeShareLink(tx: Executor, id: string): Promise<void> {
  await tx.update(shareLinks).set({ revokedAt: sql`now()` }).where(eq(shareLinks.id, id))
}

export async function listShareLinks(objectId: string) {
  return db()
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.objectId, objectId), isNull(shareLinks.revokedAt)))
}

/** Гостевые ссылки разрешены политикой безопасности (17-security.md §2). */
export async function shareLinksAllowed(): Promise<boolean> {
  return (await SecurityPolicyService.current()).allowShareLinks
}

async function assertShareLinksAllowed(): Promise<void> {
  if (!(await shareLinksAllowed())) {
    throw errors.policyViolation('Гостевые ссылки отключены политикой безопасности')
  }
}

/** Префикс токена доступа, выданного после открытия ссылки. */
const GRANT_PREFIX = 'g_'
const GRANT_TTL_SECONDS = 12 * 60 * 60

type LinkRow = Awaited<ReturnType<typeof listShareLinks>>[number]

async function liveLinkByToken(token: string): Promise<LinkRow | null> {
  const [row] = await db()
    .select()
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.token, hashToken(token)),
        isNull(shareLinks.revokedAt),
        or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, sql`now()`)),
      ),
    )
    .limit(1)
  return row ?? null
}

async function liveLinkById(id: string): Promise<LinkRow | null> {
  const [row] = await db()
    .select()
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.id, id),
        isNull(shareLinks.revokedAt),
        or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, sql`now()`)),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * Открытие объекта по ссылке (03-access-model.md §Гостевые ссылки).
 * Возвращает `null`, если ссылка не существует, отозвана, истекла или исчерпана —
 * причину не раскрываем. Для ссылки с паролем без верного пароля возвращается
 * `requiresPassword` без токена доступа.
 */
export async function openShareLink(
  token: string,
  password?: string,
): Promise<(ShareLinkOpenResult & { linkId: string }) | null> {
  // Выключение политикой действует и на выданные ссылки: причину гостю не раскрываем
  if (!(await shareLinksAllowed())) return null
  const row = await liveLinkByToken(token)
  if (!row) return null
  if (row.maxUses !== null && row.uses >= row.maxUses) return null

  if (row.passwordHash) {
    if (!password) {
      return {
        linkId: row.id,
        requiresPassword: true,
        accessToken: null,
        objectId: null,
        expiresAt: null,
        includeAttachments: row.includeAttachments,
        watermark: null,
      }
    }
    if (!(await verifyPassword(row.passwordHash, password))) {
      throw errors.unauthorized('Неверный пароль ссылки')
    }
  }

  const grant = `${GRANT_PREFIX}${randomToken(24)}`
  const ttl = grantTtlSeconds(row.expiresAt)
  await redis().set(cacheKeys.shareGrant(hashToken(grant)), row.id, 'EX', ttl)

  await db()
    .update(shareLinks)
    .set({ uses: sql`${shareLinks.uses} + 1` })
    .where(eq(shareLinks.id, row.id))

  return {
    linkId: row.id,
    requiresPassword: false,
    accessToken: grant,
    objectId: row.objectId,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    includeAttachments: row.includeAttachments,
    watermark: `Доступ по ссылке ${row.id.slice(0, 8)} · ${new Date().toISOString().slice(0, 10)}`,
  }
}

function grantTtlSeconds(expiresAt: string | null): number {
  if (!expiresAt) return GRANT_TTL_SECONDS
  const left = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)
  return Math.max(60, Math.min(GRANT_TTL_SECONDS, left))
}

/**
 * Разрешение гостевого токена в ограниченный контекст.
 * Принимает как токен доступа, выданный `openShareLink`, так и сырой токен
 * ссылки без пароля (прямая ссылка из письма).
 */
export async function resolveShareLinkCtx(token: string): Promise<UserCtx | null> {
  if (!(await shareLinksAllowed())) return null
  if (token.startsWith(GRANT_PREFIX)) {
    const linkId = await redis().get(cacheKeys.shareGrant(hashToken(token)))
    if (!linkId) return null
    const row = await liveLinkById(linkId)
    if (!row) return null
    return guestCtx(row.id, row.objectId, row.includeAttachments, token)
  }

  const row = await liveLinkByToken(token)
  if (!row) return null
  // Пароль или лимит открытий: только через openShareLink — там считаются открытия
  if (row.passwordHash || row.maxUses !== null) return null

  return guestCtx(row.id, row.objectId, row.includeAttachments, token)
}

function guestCtx(
  linkId: string,
  objectId: string,
  includeAttachments: boolean,
  token: string,
): UserCtx {
  return {
    kind: 'user',
    userId: `link:${linkId}`,
    sessionId: `link:${linkId}`,
    displayName: 'Гость по ссылке',
    locale: 'ru',
    timezone: 'Asia/Dushanbe',
    principals: { ...EMPTY_PRINCIPALS, keys: [`link:${linkId}`] },
    capabilities: new Set(),
    roleKeys: [],
    isSystemAdmin: false,
    isSecurityAuditor: false,
    onBehalfOf: null,
    shareLink: { token, objectId, includeAttachments },
    requestId: '',
    ip: null,
    userAgent: null,
    attributes: {},
    // Гость видит только общедоступное: служебное и конфиденциальное — нет (ADR-0080)
    clearance: GUEST_CLEARANCE,
    adminMode: null,
    mustChangePassword: false,
    mfaEnrollmentRequired: false,
  }
}
