import type {
  PasskeyAuthenticationOptions,
  PasskeyCredentialResponse,
  PasskeyInfo,
  PasskeyRegistrationOptions,
} from '@kchs/contracts'
import { PRODUCT_NAME } from '@kchs/contracts'
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { and, eq, gt, sql } from 'drizzle-orm'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { config } from '~/shared/config/index.js'
import { systemCtx, type UserCtx } from '~/shared/context.js'
import { hashToken } from '~/shared/crypto/secrets.js'
import { db } from '~/shared/db/client.js'
import {
  mfaChallenges,
  users,
  webauthnChallenges,
  webauthnCredentials,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { AuthService, type RequestMeta } from './auth-service.js'

/**
 * Ключи входа (passkeys, WebAuthn — ADR-0098).
 *
 * Ключ с подтверждением личности (PIN, отпечаток) — это два фактора сразу:
 * устройство и подтверждение на нём. Поэтому он и входит самостоятельно, и
 * засчитывается как второй фактор. Ключ без подтверждения (обычный токен
 * «только присутствие») самостоятельным входом не служит — только вторым
 * фактором после пароля.
 *
 * Вызов одноразовый: строка `webauthn_challenges` удаляется при первой
 * проверке, поэтому повторно предъявить ответ браузера нельзя.
 */

const CHALLENGE_MINUTES = 5
const MAX_KEYS = 20

/** Идентификатор проверяющей стороны — имя узла установки (WebAuthn: rpId). */
function relyingParty(): { id: string; origin: string; name: string } {
  const base = new URL(config().KCHS_BASE_URL)
  return { id: base.hostname, origin: base.origin, name: PRODUCT_NAME }
}

function toInfo(row: typeof webauthnCredentials.$inferSelect): PasskeyInfo {
  return {
    id: row.id,
    name: row.name ?? 'Ключ входа',
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    userVerified: row.userVerified,
    backedUp: row.backedUp,
    transports: row.transports ?? [],
  }
}

async function keysOf(userId: string) {
  return db().select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, userId))
}

async function storeChallenge(
  purpose: 'register' | 'login' | 'mfa',
  challenge: string,
  userId: string | null,
  mfaChallengeId: string | null,
): Promise<void> {
  await db()
    .insert(webauthnChallenges)
    .values({
      id: newId(),
      purpose,
      userId,
      challenge,
      mfaChallengeId,
      expiresAt: new Date(Date.now() + CHALLENGE_MINUTES * 60_000).toISOString(),
    })
}

/** Забирает вызов: удаление и проверка срока одним запросом — повтора не будет. */
async function takeChallenge(
  purpose: 'register' | 'login' | 'mfa',
  challenge: string,
): Promise<typeof webauthnChallenges.$inferSelect | null> {
  const [row] = await db()
    .delete(webauthnChallenges)
    .where(
      and(
        eq(webauthnChallenges.challenge, challenge),
        eq(webauthnChallenges.purpose, purpose),
        gt(webauthnChallenges.expiresAt, sql`now()`),
      ),
    )
    .returning()
  return row ?? null
}

/** Вызов браузера — в поле `clientDataJSON` ответа; без него проверять нечего. */
function challengeOf(credential: PasskeyCredentialResponse): string | null {
  const response = credential.response as { clientDataJSON?: unknown }
  if (typeof response?.clientDataJSON !== 'string') return null
  try {
    const parsed = JSON.parse(Buffer.from(response.clientDataJSON, 'base64url').toString('utf8'))
    return typeof parsed?.challenge === 'string' ? parsed.challenge : null
  } catch {
    return null
  }
}

export const PasskeyService = {
  async list(userId: string): Promise<PasskeyInfo[]> {
    const rows = await keysOf(userId)
    return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(toInfo)
  },

  /** Есть ли у пользователя ключ, годный как второй фактор. */
  async hasKeys(userId: string): Promise<boolean> {
    const rows = await db()
      .select({ id: webauthnCredentials.id })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId))
      .limit(1)
    return rows.length > 0
  },

  async registrationOptions(ctx: UserCtx): Promise<PasskeyRegistrationOptions> {
    const existing = await keysOf(ctx.userId)
    if (existing.length >= MAX_KEYS) throw errors.validation('Достигнут предел числа ключей')
    const rp = relyingParty()
    const [user] = await db()
      .select({ login: users.login })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1)

    const options = await generateRegistrationOptions({
      rpName: rp.name,
      rpID: rp.id,
      userName: user?.login ?? ctx.userId,
      userDisplayName: ctx.displayName,
      userID: new TextEncoder().encode(ctx.userId),
      attestationType: 'none',
      // Уже добавленный ключ браузер предложит не регистрировать повторно
      excludeCredentials: existing.map((row) => ({
        id: row.id,
        transports: (row.transports ?? []) as AuthenticatorTransport[],
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    })
    await storeChallenge('register', options.challenge, ctx.userId, null)
    return { ...options }
  },

  async register(
    ctx: UserCtx,
    name: string,
    credential: PasskeyCredentialResponse,
  ): Promise<PasskeyInfo> {
    const challenge = challengeOf(credential)
    if (!challenge) throw errors.validation('Ответ ключа не распознан')
    const stored = await takeChallenge('register', challenge)
    if (!stored || stored.userId !== ctx.userId) {
      throw errors.validation('Время подтверждения истекло, начните заново')
    }

    const rp = relyingParty()
    const verified = await verifyRegistrationResponse({
      response: credential as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
    }).catch(() => ({ verified: false }) as const)

    if (!verified.verified || !verified.registrationInfo) {
      throw errors.validation('Ключ не подтверждён')
    }
    const info = verified.registrationInfo

    const [row] = await db()
      .insert(webauthnCredentials)
      .values({
        id: info.credential.id,
        userId: ctx.userId,
        publicKey: Buffer.from(info.credential.publicKey),
        counter: info.credential.counter,
        transports: info.credential.transports ?? [],
        name: name.slice(0, 100),
        userVerified: info.userVerified,
        backedUp: info.credentialBackedUp,
        aaguid: info.aaguid,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw errors.conflict('Этот ключ уже добавлен')

    await audit(ctx, {
      action: AUDIT_ACTIONS.passkeyAdded,
      objectId: ctx.userId,
      objectType: 'user',
      details: { name: row.name, userVerified: row.userVerified },
      severity: 'notice',
    })
    await db().transaction(async (tx) => {
      await publishEvent(tx, ctx, {
        type: 'user.passkey_added',
        object: { id: ctx.userId, type: 'user' },
        payload: { userId: ctx.userId, name: row.name ?? '' },
      })
    })
    return toInfo(row)
  },

  async remove(ctx: UserCtx, id: string): Promise<void> {
    const [row] = await db()
      .delete(webauthnCredentials)
      .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, ctx.userId)))
      .returning()
    if (!row) throw errors.notFound('Ключ входа')
    await audit(ctx, {
      action: AUDIT_ACTIONS.passkeyRemoved,
      objectId: ctx.userId,
      objectType: 'user',
      details: { name: row.name },
      severity: 'notice',
    })
    await db().transaction(async (tx) => {
      await publishEvent(tx, ctx, {
        type: 'user.passkey_removed',
        object: { id: ctx.userId, type: 'user' },
        payload: { userId: ctx.userId, name: row.name ?? '' },
      })
    })
  },

  /**
   * Вход по ключу без логина: браузер сам показывает подходящие ключи
   * (discoverable credentials), поэтому список допустимых не передаётся.
   */
  async loginOptions(): Promise<PasskeyAuthenticationOptions> {
    const options = await generateAuthenticationOptions({
      rpID: relyingParty().id,
      userVerification: 'required',
    })
    await storeChallenge('login', options.challenge, null, null)
    return { ...options }
  },

  async login(
    credential: PasskeyCredentialResponse,
    meta: RequestMeta,
  ): Promise<{ sessionToken: string; csrfToken: string; expiresAt: string; userId: string }> {
    const challenge = challengeOf(credential)
    if (!challenge) throw errors.unauthorized('Ключ не подтверждён')
    const stored = await takeChallenge('login', challenge)
    if (!stored) throw errors.unauthorized('Время подтверждения истекло, начните заново')

    const row = await verify(credential, challenge, true)
    const [user] = await db()
      .select({ status: users.status, mustChangePassword: users.mustChangePassword })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1)
    if (user?.status !== 'active') {
      await audit(systemCtx('auth.passkey', { requestId: meta.requestId }), {
        action: AUDIT_ACTIONS.loginFailed,
        actorId: row.userId,
        details: { method: 'passkey', reason: `status_${user?.status ?? 'unknown'}` },
        severity: 'warning',
        ip: meta.ip,
        userAgent: meta.userAgent,
      })
      throw errors.unauthorized('Учётная запись отключена. Обратитесь к администратору')
    }

    const session = await AuthService.createSession(row.userId, meta, true)
    await AuthService.afterLogin(row.userId, meta)
    await audit(systemCtx('auth.passkey', { requestId: meta.requestId, initiatorId: row.userId }), {
      action: AUDIT_ACTIONS.loginExternal,
      actorId: row.userId,
      objectId: row.userId,
      objectType: 'user',
      details: { method: 'passkey' },
      severity: 'notice',
      ip: meta.ip,
      userAgent: meta.userAgent,
    })
    return { ...session, userId: row.userId }
  },

  /** Ключ как второй фактор: поверх незавершённого входа по паролю. */
  async mfaOptions(challengeToken: string): Promise<PasskeyAuthenticationOptions> {
    const pending = await pendingLogin(challengeToken)
    const keys = await keysOf(pending.userId)
    if (keys.length === 0) throw errors.validation('Ключей входа нет')
    const options = await generateAuthenticationOptions({
      rpID: relyingParty().id,
      allowCredentials: keys.map((row) => ({
        id: row.id,
        transports: (row.transports ?? []) as AuthenticatorTransport[],
      })),
      // Первый фактор — пароль: подтверждение на ключе здесь не обязательно
      userVerification: 'preferred',
    })
    await storeChallenge('mfa', options.challenge, pending.userId, pending.id)
    return { ...options }
  },

  async mfaVerify(
    challengeToken: string,
    credential: PasskeyCredentialResponse,
    meta: RequestMeta,
  ): Promise<{
    sessionToken: string
    csrfToken: string
    expiresAt: string
    userId: string
    mustChangePassword: boolean
  }> {
    const pending = await pendingLogin(challengeToken)
    const challenge = challengeOf(credential)
    if (!challenge) throw errors.unauthorized('Ключ не подтверждён')
    const stored = await takeChallenge('mfa', challenge)
    if (!stored || stored.mfaChallengeId !== pending.id) {
      throw errors.unauthorized('Время подтверждения истекло, войдите заново')
    }

    const row = await verify(credential, challenge, false)
    if (row.userId !== pending.userId) throw errors.unauthorized('Ключ не подтверждён')

    await db().delete(mfaChallenges).where(eq(mfaChallenges.id, pending.id))
    const [user] = await db()
      .select({ status: users.status, mustChangePassword: users.mustChangePassword })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1)
    if (user?.status !== 'active') {
      throw errors.unauthorized('Учётная запись отключена. Обратитесь к администратору')
    }

    const session = await AuthService.createSession(row.userId, meta, true)
    await AuthService.afterLogin(row.userId, meta)
    return { ...session, userId: row.userId, mustChangePassword: user.mustChangePassword }
  },
}

async function pendingLogin(challengeToken: string): Promise<{ id: string; userId: string }> {
  const [row] = await db()
    .select({ id: mfaChallenges.id, userId: mfaChallenges.userId })
    .from(mfaChallenges)
    .where(
      and(
        eq(mfaChallenges.tokenHash, hashToken(challengeToken)),
        gt(mfaChallenges.expiresAt, sql`now()`),
      ),
    )
    .limit(1)
  if (!row) throw errors.unauthorized('Время подтверждения истекло, войдите заново')
  return row
}

/**
 * Проверка подписи ключа и счётчика. Отозванный ключ здесь не находится —
 * строка удалена, значит и вход по нему невозможен.
 */
async function verify(
  credential: PasskeyCredentialResponse,
  challenge: string,
  requireUserVerification: boolean,
): Promise<typeof webauthnCredentials.$inferSelect> {
  const [row] = await db()
    .select()
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.id, credential.id))
    .limit(1)
  if (!row) throw errors.unauthorized('Ключ не подтверждён')
  if (requireUserVerification && !row.userVerified) {
    throw errors.unauthorized('Этот ключ не подтверждает личность: войдите паролем')
  }

  const rp = relyingParty()
  const verified = await verifyAuthenticationResponse({
    response: credential as unknown as AuthenticationResponseJSON,
    expectedChallenge: challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    credential: {
      id: row.id,
      publicKey: new Uint8Array(row.publicKey),
      counter: row.counter,
      transports: (row.transports ?? []) as AuthenticatorTransport[],
    },
    requireUserVerification,
  }).catch(() => ({ verified: false }) as const)

  if (!verified.verified || !('authenticationInfo' in verified)) {
    throw errors.unauthorized('Ключ не подтверждён')
  }

  // Счётчик растёт: откат означает клонированный ключ — такую подпись не принимаем
  const next = verified.authenticationInfo.newCounter
  const [updated] = await db()
    .update(webauthnCredentials)
    .set({
      counter: next,
      lastUsedAt: sql`now()`,
      backedUp: verified.authenticationInfo.credentialBackedUp,
    })
    .where(
      and(
        eq(webauthnCredentials.id, row.id),
        next > 0 ? sql`${webauthnCredentials.counter} < ${next}` : sql`true`,
      ),
    )
    .returning()
  if (!updated) throw errors.unauthorized('Ключ не подтверждён')
  return updated
}

/**
 * Зарегистрирован ли на установке хотя бы один ключ — экран входа показывает
 * кнопку «Войти по ключу» только тогда. Чей это ключ, наружу не сообщается.
 */
export async function anyPasskeysExist(): Promise<boolean> {
  const rows = await db().select({ id: webauthnCredentials.id }).from(webauthnCredentials).limit(1)
  return rows.length > 0
}
