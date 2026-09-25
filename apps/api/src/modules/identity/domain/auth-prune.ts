import { and, isNotNull, lt, or, sql } from 'drizzle-orm'
import { db } from '~/shared/db/client.js'
import {
  mfaChallenges,
  passwordResets,
  sessions,
  ssoAuthRequests,
  webauthnChallenges,
} from '~/shared/db/schema/index.js'

/** Истёкшее ещё сутки лежит — для разбора «почему не вошёл» по свежим следам. */
const CHALLENGE_GRACE = sql`now() - interval '1 day'`
/** Сессии и ссылки сброса — неделю: история входов остаётся в журнале аудита. */
const HISTORY_GRACE = sql`now() - interval '7 days'`

export interface AuthPruneResult {
  sessions: number
  mfaChallenges: number
  passkeyChallenges: number
  ssoRequests: number
  passwordResets: number
}

/**
 * Ежедневная чистка следов входа (N82, 15-admin-operations.md §6): истёкшие и
 * отозванные сессии, брошенные вызовы второго фактора и ключей входа, незавершённые
 * входы через IdP (с зашифрованным проверочным кодом PKCE и `nonce`) и ссылки сброса
 * пароля. Одноразовость им обеспечивает `used_at` и срок, а не удаление — поэтому без
 * чистки брошенная вкладка оставляла строку навсегда.
 */
export async function pruneAuthArtifacts(): Promise<AuthPruneResult> {
  const count = async (query: Promise<Array<{ id: unknown }>>) => (await query).length
  return {
    sessions: await count(
      db()
        .delete(sessions)
        .where(
          or(
            lt(sessions.expiresAt, HISTORY_GRACE),
            and(isNotNull(sessions.revokedAt), lt(sessions.revokedAt, HISTORY_GRACE)),
          ),
        )
        .returning({ id: sessions.id }),
    ),
    mfaChallenges: await count(
      db()
        .delete(mfaChallenges)
        .where(lt(mfaChallenges.expiresAt, CHALLENGE_GRACE))
        .returning({ id: mfaChallenges.id }),
    ),
    passkeyChallenges: await count(
      db()
        .delete(webauthnChallenges)
        .where(lt(webauthnChallenges.expiresAt, CHALLENGE_GRACE))
        .returning({ id: webauthnChallenges.id }),
    ),
    ssoRequests: await count(
      db()
        .delete(ssoAuthRequests)
        .where(lt(ssoAuthRequests.expiresAt, CHALLENGE_GRACE))
        .returning({ id: ssoAuthRequests.id }),
    ),
    passwordResets: await count(
      db()
        .delete(passwordResets)
        .where(
          or(
            lt(passwordResets.expiresAt, HISTORY_GRACE),
            and(isNotNull(passwordResets.usedAt), lt(passwordResets.usedAt, HISTORY_GRACE)),
          ),
        )
        .returning({ id: passwordResets.id }),
    ),
  }
}
