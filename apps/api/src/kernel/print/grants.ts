import { REPORT_PRINT } from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import type { UserCtx } from '~/shared/context.js'
import { hashToken } from '~/shared/crypto/secrets.js'
import { db } from '~/shared/db/client.js'
import { users } from '~/shared/db/schema/index.js'
import { randomToken } from '~/shared/ids.js'
import { cacheKeys, redis } from '~/shared/redis/index.js'
import { buildUserCtxFor } from '../access/explain.js'

interface StoredGrant {
  userId: string
  scope: string
}

const ttlSeconds = () => Math.ceil(REPORT_PRINT.grantTtlMs / 1000)

/**
 * Служебный токен страницы печати (ADR-0022, ADR-0078). Движок открывает
 * `/print/*` веба в headless Chromium без пароля пользователя: api выдаёт ему
 * токен по внутреннему маршруту (сервисный токен), движок кладёт его в cookie
 * `kchs_print` своего браузера. Токен:
 *  - действует на одну область (`scope`, например `report-run:<id>`) и не
 *    дольше `REPORT_PRINT.grantTtlMs`; новая выдача той же области гасит прежнюю,
 *    конец запуска отзывает его;
 *  - даёт контекст того пользователя, под чьими правами строится документ
 *    (активного), — только чтение: маршруты GET и запросы данных `readOnly`;
 *  - хранится в Redis хешем: сам токен знают только движок и его браузер.
 */
export const PrintGrants = {
  async issue(input: { userId: string; scope: string }): Promise<{ token: string }> {
    await PrintGrants.revoke(input.scope)
    const token = `p_${randomToken(24)}`
    const hash = hashToken(token)
    const stored: StoredGrant = { userId: input.userId, scope: input.scope }
    await redis()
      .multi()
      .set(cacheKeys.printGrant(hash), JSON.stringify(stored), 'EX', ttlSeconds())
      .set(cacheKeys.printScope(input.scope), hash, 'EX', ttlSeconds())
      .exec()
    return { token }
  },

  /** Отзыв токена области: запуск закончен (успех, сбой, пропуск). */
  async revoke(scope: string): Promise<void> {
    const hash = await redis().get(cacheKeys.printScope(scope))
    if (!hash) return
    await redis().del(cacheKeys.printGrant(hash), cacheKeys.printScope(scope))
  },

  /**
   * Контекст запроса страницы печати: пользователь области, если токен жив и
   * учётная запись активна; иначе null — ответ 401.
   */
  async resolve(token: string): Promise<UserCtx | null> {
    if (!token.startsWith('p_') || token.length > 100) return null
    const raw = await redis().get(cacheKeys.printGrant(hashToken(token)))
    if (!raw) return null
    let grant: StoredGrant
    try {
      grant = JSON.parse(raw) as StoredGrant
    } catch {
      return null
    }
    const [user] = await db()
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, grant.userId))
      .limit(1)
    // Отключённая учётная запись не читает данные и через печать
    if (user?.status !== 'active') return null
    const ctx = await buildUserCtxFor(grant.userId)
    if (!ctx) return null
    return { ...ctx, sessionId: `print:${grant.scope}`, print: { scope: grant.scope } }
  },
}
