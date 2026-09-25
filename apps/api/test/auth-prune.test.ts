import { inArray, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { createUser, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Чистка следов входа (N82): истёкшие и отозванные неделю назад сессии, брошенные вызовы
 * второго фактора и ключей входа, незавершённые входы через IdP и ссылки сброса пароля
 * удаляются ежедневным заданием, свежие и действующие — остаются.
 */
registerLifecycle()

const { pruneAuthArtifacts } = await import('../src/modules/identity/domain/auth-prune.js')
const { mfaChallenges, passwordResets, sessions, ssoAuthRequests, webauthnChallenges } =
  await import('../src/shared/db/schema/index.js')
const { newId } = await import('../src/shared/ids.js')

let fx: TestContext
const ago = (hours: number) => sql`now() - make_interval(hours => ${hours})`
const ahead = (hours: number) => sql`now() + make_interval(hours => ${hours})`

beforeAll(async () => {
  fx = await setupFixture()
})

describe('чистка следов входа', () => {
  it('удаляет просроченное с запасом и не трогает действующее', async () => {
    const user = await createUser(fx.app, `prune_${Date.now().toString(36)}`)
    const id = () => newId()
    const ids = {
      oldSession: id(),
      revokedSession: id(),
      freshExpiredSession: id(),
      activeSession: id(),
      oldChallenge: id(),
      freshChallenge: id(),
      passkeyChallenge: id(),
      ssoRequest: id(),
      usedReset: id(),
      freshReset: id(),
    }
    const session = (
      key: string,
      expires: ReturnType<typeof ago>,
      revoked?: ReturnType<typeof ago>,
    ) => ({
      id: key,
      userId: user.id,
      tokenHash: `t-${key}`,
      csrfToken: `c-${key}`,
      expiresAt: expires as unknown as string,
      ...(revoked ? { revokedAt: revoked as unknown as string } : {}),
    })
    await db()
      .insert(sessions)
      .values([
        session(ids.oldSession, ago(8 * 24)),
        session(ids.revokedSession, ahead(24), ago(8 * 24)),
        session(ids.freshExpiredSession, ago(2)),
        session(ids.activeSession, ahead(24)),
      ])
    await db()
      .insert(mfaChallenges)
      .values([
        {
          id: ids.oldChallenge,
          userId: user.id,
          tokenHash: `m-${ids.oldChallenge}`,
          expiresAt: ago(48) as unknown as string,
        },
        {
          id: ids.freshChallenge,
          userId: user.id,
          tokenHash: `m-${ids.freshChallenge}`,
          expiresAt: ago(1) as unknown as string,
        },
      ])
    await db()
      .insert(webauthnChallenges)
      .values({
        id: ids.passkeyChallenge,
        purpose: 'login',
        challenge: `w-${ids.passkeyChallenge}`,
        expiresAt: ago(48) as unknown as string,
      })
    await db()
      .insert(ssoAuthRequests)
      .values({
        id: ids.ssoRequest,
        provider: 'oidc',
        stateHash: `s-${ids.ssoRequest}`,
        nonce: 'n',
        codeVerifierEnc: Buffer.from('x'),
        expiresAt: ago(48) as unknown as string,
      })
    await db()
      .insert(passwordResets)
      .values([
        {
          id: ids.usedReset,
          userId: user.id,
          tokenHash: `r-${ids.usedReset}`,
          expiresAt: ago(8 * 24 - 1) as unknown as string,
          usedAt: ago(8 * 24) as unknown as string,
        },
        {
          id: ids.freshReset,
          userId: user.id,
          tokenHash: `r-${ids.freshReset}`,
          expiresAt: ahead(1) as unknown as string,
        },
      ])

    const result = await pruneAuthArtifacts()
    expect(result.sessions).toBeGreaterThanOrEqual(2)
    expect(result.mfaChallenges).toBeGreaterThanOrEqual(1)
    expect(result.passkeyChallenges).toBeGreaterThanOrEqual(1)
    expect(result.ssoRequests).toBeGreaterThanOrEqual(1)
    expect(result.passwordResets).toBeGreaterThanOrEqual(1)

    const left = async (
      table: typeof sessions | typeof mfaChallenges | typeof passwordResets,
      keys: string[],
    ) =>
      (await db().select({ id: table.id }).from(table).where(inArray(table.id, keys)))
        .map((row) => row.id)
        .sort()
    expect(
      await left(sessions, [
        ids.oldSession,
        ids.revokedSession,
        ids.freshExpiredSession,
        ids.activeSession,
      ]),
    ).toEqual([ids.freshExpiredSession, ids.activeSession].sort())
    expect(await left(mfaChallenges, [ids.oldChallenge, ids.freshChallenge])).toEqual([
      ids.freshChallenge,
    ])
    expect(await left(passwordResets, [ids.usedReset, ids.freshReset])).toEqual([ids.freshReset])
    const passkeys = await db()
      .select({ id: webauthnChallenges.id })
      .from(webauthnChallenges)
      .where(inArray(webauthnChallenges.id, [ids.passkeyChallenge]))
    expect(passkeys).toEqual([])
    const sso = await db()
      .select({ id: ssoAuthRequests.id })
      .from(ssoAuthRequests)
      .where(inArray(ssoAuthRequests.id, [ids.ssoRequest]))
    expect(sso).toEqual([])
  })
})
