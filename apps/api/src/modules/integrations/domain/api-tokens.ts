import { randomBytes } from 'node:crypto'
import type { ApiToken, ApiTokenCreateInput } from '@kchs/contracts'
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import type { UserCtx } from '~/shared/context.js'
import { hashToken, safeEqual } from '~/shared/crypto/secrets.js'
import { db } from '~/shared/db/client.js'
import type { ApiTokenRow } from '~/shared/db/schema/index.js'
import { apiTokens, users } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'

/** Опознавательный префикс токена: по нему видно, что это ключ kchs. */
const TOKEN_PREFIX = 'kchs'
/** Формат: `kchs_<16 hex поиска>_<43 символа секрета>`. */
const LOOKUP_BYTES = 8
const SECRET_BYTES = 32

export interface IssuedToken {
  token: ApiToken
  secret: string
}

function status(row: {
  revokedAt: string | null
  expiresAt: string | null
}): 'active' | 'revoked' | 'expired' {
  if (row.revokedAt) return 'revoked'
  if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return 'expired'
  return 'active'
}

async function present(rows: ApiTokenRow[]): Promise<ApiToken[]> {
  const userIds = new Set<string>()
  for (const row of rows) {
    userIds.add(row.userId)
    if (row.createdById) userIds.add(row.createdById)
  }
  const refs = await directory().refs([...userIds])
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    userId: row.userId,
    userName: refs.get(row.userId)?.displayName ?? null,
    createdById: row.createdById,
    createdByName: row.createdById ? (refs.get(row.createdById)?.displayName ?? null) : null,
    scopes: row.scopes as ApiToken['scopes'],
    prefix: row.prefix,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    revokedById: row.revokedById,
    rateLimitPerMinute: row.rateLimitPerMinute,
    createdAt: row.createdAt,
    status: status(row),
  }))
}

export const ApiTokens = {
  /**
   * Выпускает токен. Токен не может дать больше, чем есть у его владельца:
   * области — лишь дополнительное сужение прав (ADR-0097). Выпустить токен на
   * другого человека (служебная учётная запись) может только администратор
   * системы — это отдельное действие с записью в аудит.
   */
  async issue(ctx: UserCtx, input: ApiTokenCreateInput): Promise<IssuedToken> {
    const ownerId = input.userId ?? ctx.userId
    if (ownerId !== ctx.userId && !ctx.isSystemAdmin) {
      throw errors.forbidden('Токен на другого пользователя выпускает администратор системы')
    }
    if (ctx.apiToken) throw errors.forbidden('Токен не может выпускать другие токены')
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) {
      throw errors.validation('Срок действия уже прошёл')
    }

    const [owner] = await db()
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1)
    if (!owner) throw errors.validation('Пользователь не найден')
    if (owner.status !== 'active') throw errors.validation('Учётная запись отключена')

    const prefix = randomBytes(LOOKUP_BYTES).toString('hex')
    const secretPart = randomBytes(SECRET_BYTES).toString('base64url')
    const secret = `${TOKEN_PREFIX}_${prefix}_${secretPart}`
    const id = newId()

    const [row] = await db().transaction(async (tx) => {
      const inserted = await tx
        .insert(apiTokens)
        .values({
          id,
          userId: ownerId,
          name: input.name,
          prefix,
          tokenHash: hashToken(secret),
          scopes: [...input.scopes],
          createdById: ctx.userId,
          expiresAt: input.expiresAt ?? null,
          rateLimitPerMinute: input.rateLimitPerMinute ?? null,
        })
        .returning()
      await publishEvent(tx, ctx, {
        type: 'token.created',
        payload: {
          tokenId: id,
          userId: ownerId,
          prefix,
          scopes: [...input.scopes],
          expiresAt: input.expiresAt ?? null,
        },
      })
      return inserted
    })
    if (!row) throw errors.internal('Токен не создан')

    await audit(ctx, {
      action: AUDIT_ACTIONS.apiTokenCreated,
      objectId: null,
      objectType: 'api_token',
      severity: 'notice',
      details: { tokenId: id, prefix, forUserId: ownerId, scopes: input.scopes },
    })

    const [token] = await present([row])
    if (!token) throw errors.internal('Токен не создан')
    return { token, secret }
  },

  /** Токены человека (`Мои токены`) или все токены установки (администрирование). */
  async list(options: { userId?: string; includeRevoked?: boolean }): Promise<ApiToken[]> {
    const conditions = [
      options.userId ? eq(apiTokens.userId, options.userId) : undefined,
      options.includeRevoked ? undefined : isNull(apiTokens.revokedAt),
    ].filter((value) => value !== undefined)
    const rows = await db()
      .select()
      .from(apiTokens)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(apiTokens.createdAt))
      .limit(500)
    return present(rows)
  },

  /** Отзыв: свой токен — сам, чужой — администратор системы. */
  async revoke(ctx: UserCtx, id: string): Promise<void> {
    const [row] = await db().select().from(apiTokens).where(eq(apiTokens.id, id)).limit(1)
    // Чужой токен не раскрывается: для не-администратора его просто нет
    if (!row || (row.userId !== ctx.userId && !ctx.isSystemAdmin)) throw errors.notFound('Токен')
    if (row.revokedAt) return

    await db().transaction(async (tx) => {
      await tx
        .update(apiTokens)
        .set({ revokedAt: sql`now()`, revokedById: ctx.userId })
        .where(eq(apiTokens.id, id))
      await publishEvent(tx, ctx, {
        type: 'token.revoked',
        payload: { tokenId: id, userId: row.userId, prefix: row.prefix },
      })
    })

    await audit(ctx, {
      action: AUDIT_ACTIONS.apiTokenRevoked,
      objectId: null,
      objectType: 'api_token',
      severity: 'notice',
      details: { tokenId: id, prefix: row.prefix, ownerId: row.userId },
    })
  },

  /**
   * Находит действующий токен по предъявленному секрету. Поиск — по видимому
   * префиксу, сравнение — по хэшу в постоянное время: сам токен нигде не
   * хранится и в журналы не попадает.
   */
  async resolve(secret: string): Promise<ApiTokenRow | null> {
    const parts = secret.split('_')
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null
    const [, prefix, tail] = parts
    if (!prefix || !tail || prefix.length !== LOOKUP_BYTES * 2) return null

    const [row] = await db().select().from(apiTokens).where(eq(apiTokens.prefix, prefix)).limit(1)
    if (!row) return null
    if (!safeEqual(row.tokenHash, hashToken(secret))) return null
    if (row.revokedAt) return null
    if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return null
    return row
  },

  /** Отметка последнего использования — не чаще раза в минуту на токен. */
  async touch(id: string, ip: string | null): Promise<void> {
    await db()
      .update(apiTokens)
      .set({ lastUsedAt: sql`now()`, lastUsedIp: ip })
      .where(
        and(
          eq(apiTokens.id, id),
          or(
            isNull(apiTokens.lastUsedAt),
            sql`${apiTokens.lastUsedAt} < now() - interval '1 minute'`,
          ),
        ),
      )
  },
}
