import {
  type AdminModeInput,
  type AdminModeState,
  type Confidentiality,
  PRODUCT_NAME,
  parseConfidentiality,
} from '@kchs/contracts'
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { authenticator } from 'otplib'
import { invalidatePrincipalSet } from '~/kernel/access/principal-set.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { SecurityPolicyService } from '~/kernel/settings/security-policy.js'
import { config } from '~/shared/config/index.js'
import { systemCtx, type UserCtx } from '~/shared/context.js'
import { checkPasswordPolicy, hashPassword, verifyPassword } from '~/shared/crypto/password.js'
import { decryptSecret, encryptSecret, hashToken } from '~/shared/crypto/secrets.js'
import { db, type Executor } from '~/shared/db/client.js'
import {
  credentials,
  mfaChallenges,
  mfaFactors,
  passwordResets,
  recoveryCodes,
  sessions,
  users,
  webauthnCredentials,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId, randomCode, randomToken } from '~/shared/ids.js'
import { AuthProviders } from './auth-providers.js'
import { entryDisabled, LdapClient } from './ldap-client.js'

let dummyPasswordHash: string | null = null

/** Хеш-заглушка для неизвестных логинов: время ответа как у существующих. */
async function dummyHash(): Promise<string> {
  dummyPasswordHash ??= await hashPassword(`dummy-${randomToken(16)}`)
  return dummyPasswordHash
}

const MAX_FAILED_ATTEMPTS = 10
const LOCK_MINUTES = 15
const MFA_CHALLENGE_MINUTES = 10
const PASSWORD_RESET_MINUTES = 15
const PASSWORD_HISTORY = 5

authenticator.options = { window: 1, step: 30 }

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
  requestId: string
}

/** Чем можно подтвердить второй фактор в этом вызове входа (ADR-0098). */
export type SecondFactorMethod = 'totp' | 'recovery_code' | 'passkey'

export type LoginOutcome =
  | { status: 'ok'; sessionToken: string; csrfToken: string; userId: string; expiresAt: string }
  | {
      status: 'mfa_required'
      challengeToken: string
      challengeId: string
      expiresAt: string
      methods: SecondFactorMethod[]
    }
  | {
      status: 'password_change_required'
      sessionToken: string
      csrfToken: string
      userId: string
      expiresAt: string
    }

export const AuthService = {
  /** Вход по логину и паролю с блокировкой после серии неудач (17-security.md §2). */
  async login(login: string, password: string, meta: RequestMeta): Promise<LoginOutcome> {
    const sys = systemCtx('auth.login', { requestId: meta.requestId })
    const [user] = await db()
      .select({
        id: users.id,
        login: users.login,
        status: users.status,
        kind: users.kind,
        displayName: users.displayName,
        mustChangePassword: users.mustChangePassword,
        authSource: users.authSource,
        directoryDn: users.directoryDn,
      })
      .from(users)
      .where(
        or(
          sql`lower(${users.login}) = ${login.toLowerCase()}`,
          sql`lower(${users.email}) = ${login.toLowerCase()}`,
        ),
      )
      .limit(1)

    const [cred] = user
      ? await db().select().from(credentials).where(eq(credentials.userId, user.id)).limit(1)
      : []

    // Служебная учётная запись (ADR-0130) не входит никак: пароля у неё нет, а ответ —
    // тот же, что неизвестному логину, чтобы не раскрывать вид учётной записи
    if (!user || !cred || user.kind === 'service') {
      // Хеш считается и для неизвестного логина: по времени ответа не понять,
      // существует ли учётная запись
      await verifyPassword(await dummyHash(), password)
      await audit(sys, {
        action: AUDIT_ACTIONS.loginFailed,
        ...(user?.kind === 'service' ? { actorId: user.id } : {}),
        details: { login, reason: user?.kind === 'service' ? 'service_account' : 'unknown_user' },
        severity: 'notice',
        ip: meta.ip,
        userAgent: meta.userAgent,
      })
      // Сообщение не раскрывает существование учётной записи
      throw errors.unauthorized('Неверный логин или пароль')
    }

    // Учётная запись каталога проверяет пароль привязкой в каталоге (ADR-0098);
    // локального пароля у неё нет. Блокировка, аудит и политика сессий —
    // те же самые: путь входа ниже общий
    const valid =
      user.authSource === 'ldap'
        ? await verifyDirectoryPassword(user.login, user.directoryDn, password)
        : await verifyPassword(cred.passwordHash, password)

    if (cred.lockedUntil && new Date(cred.lockedUntil) > new Date()) {
      await audit(sys, {
        action: AUDIT_ACTIONS.loginFailed,
        actorId: user.id,
        details: { login, reason: 'locked' },
        severity: 'notice',
        ip: meta.ip,
        userAgent: meta.userAgent,
      })
      // О блокировке узнаёт только знающий пароль: иначе блокировка раскрывала бы,
      // что учётная запись существует
      if (!valid) throw errors.unauthorized('Неверный логин или пароль')
      const minutes = Math.ceil((new Date(cred.lockedUntil).getTime() - Date.now()) / 60000)
      throw errors.unauthorized(
        `Учётная запись временно заблокирована, повторите через ${minutes} мин`,
      )
    }

    if (!valid) {
      const attempts = cred.failedAttempts + 1
      const lock = attempts >= MAX_FAILED_ATTEMPTS
      await db()
        .update(credentials)
        .set({
          failedAttempts: lock ? 0 : attempts,
          lockedUntil: lock ? sql`now() + make_interval(mins => ${LOCK_MINUTES})` : null,
        })
        .where(eq(credentials.userId, user.id))

      await audit(sys, {
        action: AUDIT_ACTIONS.loginFailed,
        actorId: user.id,
        details: { login, reason: 'bad_password', attempts, locked: lock },
        severity: lock ? 'warning' : 'notice',
        ip: meta.ip,
        userAgent: meta.userAgent,
      })
      await db().transaction(async (tx) => {
        await publishEvent(tx, sys, {
          type: 'user.login_failed',
          object: { id: user.id, type: 'user' },
          payload: { login, reason: 'bad_password' },
        })
      })
      throw errors.unauthorized('Неверный логин или пароль')
    }

    if (user.status !== 'active') {
      await audit(sys, {
        action: AUDIT_ACTIONS.loginFailed,
        actorId: user.id,
        details: { reason: `status_${user.status}` },
        severity: 'warning',
        ip: meta.ip,
        userAgent: meta.userAgent,
      })
      throw errors.unauthorized('Учётная запись отключена. Обратитесь к администратору')
    }

    await db()
      .update(credentials)
      .set({ failedAttempts: 0, lockedUntil: null })
      .where(eq(credentials.userId, user.id))

    const methods = await AuthService.secondFactorMethods(user.id)

    if (methods.length > 0) {
      const challengeToken = randomToken(32)
      const challengeId = newId()
      await db()
        .insert(mfaChallenges)
        .values({
          id: challengeId,
          userId: user.id,
          tokenHash: hashToken(challengeToken),
          ip: meta.ip,
          userAgent: meta.userAgent,
          expiresAt: new Date(Date.now() + MFA_CHALLENGE_MINUTES * 60_000).toISOString(),
        })
      return {
        status: 'mfa_required',
        challengeToken,
        challengeId,
        expiresAt: new Date(Date.now() + MFA_CHALLENGE_MINUTES * 60_000).toISOString(),
        methods,
      }
    }

    const session = await AuthService.createSession(user.id, meta, false)
    await AuthService.afterLogin(user.id, meta)
    return user.mustChangePassword
      ? { status: 'password_change_required', ...session }
      : { status: 'ok', ...session }
  },

  async verifyMfa(
    challengeToken: string,
    code: string,
    meta: RequestMeta,
  ): Promise<{
    sessionToken: string
    csrfToken: string
    userId: string
    expiresAt: string
    mustChangePassword: boolean
  }> {
    const [challenge] = await db()
      .select()
      .from(mfaChallenges)
      .where(
        and(
          eq(mfaChallenges.tokenHash, hashToken(challengeToken)),
          gt(mfaChallenges.expiresAt, sql`now()`),
        ),
      )
      .limit(1)

    if (!challenge) throw errors.unauthorized('Время подтверждения истекло, войдите заново')
    if (challenge.attempts >= 5) {
      await db().delete(mfaChallenges).where(eq(mfaChallenges.id, challenge.id))
      throw errors.unauthorized('Слишком много попыток, войдите заново')
    }

    const ok =
      (await AuthService.verifyTotp(challenge.userId, code)) ||
      (await AuthService.consumeRecoveryCode(challenge.userId, code))

    if (!ok) {
      await db()
        .update(mfaChallenges)
        .set({ attempts: challenge.attempts + 1 })
        .where(eq(mfaChallenges.id, challenge.id))
      throw errors.unauthorized('Неверный код')
    }

    await db().delete(mfaChallenges).where(eq(mfaChallenges.id, challenge.id))

    // Между паролем и кодом учётную запись могли отключить
    const [user] = await db()
      .select({ status: users.status, mustChangePassword: users.mustChangePassword })
      .from(users)
      .where(eq(users.id, challenge.userId))
      .limit(1)
    if (user?.status !== 'active') {
      throw errors.unauthorized('Учётная запись отключена. Обратитесь к администратору')
    }

    const session = await AuthService.createSession(challenge.userId, meta, true)
    await AuthService.afterLogin(challenge.userId, meta)
    return { ...session, mustChangePassword: user.mustChangePassword }
  },

  async verifyTotp(userId: string, code: string): Promise<boolean> {
    const factors = await db()
      .select()
      .from(mfaFactors)
      .where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.kind, 'totp')))
    const token = code.replace(/\s/g, '')
    for (const factor of factors) {
      const secret = decryptSecret(factor.secretEnc)
      const delta = authenticator.checkDelta(token, secret)
      if (delta === null) continue
      // Шаг TOTP, которому принадлежит код: повтор того же кода отклоняется
      const step = Math.floor(Date.now() / 1000 / authenticator.allOptions().step) + delta
      if (factor.lastStep !== null && step <= factor.lastStep) return false
      const updated = await db()
        .update(mfaFactors)
        .set({
          lastUsedAt: sql`now()`,
          lastStep: step,
          verifiedAt: factor.verifiedAt ?? sql`now()`,
        })
        .where(
          and(
            eq(mfaFactors.id, factor.id),
            sql`(${mfaFactors.lastStep} is null or ${mfaFactors.lastStep} < ${step})`,
          ),
        )
        .returning({ id: mfaFactors.id })
      // Параллельный запрос с тем же кодом успел раньше
      return updated.length > 0
    }
    return false
  },

  async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const normalized = code.replace(/[\s-]/g, '').toUpperCase()
    const rows = await db()
      .select()
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
    for (const row of rows) {
      if (row.codeHash === hashToken(normalized)) {
        await db()
          .update(recoveryCodes)
          .set({ usedAt: sql`now()` })
          .where(eq(recoveryCodes.id, row.id))
        return true
      }
    }
    return false
  },

  async createSession(
    userId: string,
    meta: RequestMeta,
    mfaVerified: boolean,
  ): Promise<{ sessionToken: string; csrfToken: string; userId: string; expiresAt: string }> {
    // Общий рубеж пароля, LDAP, OIDC и ключа входа: служебной учётной записи
    // (ADR-0130) сессия не выдаётся ни одним способом
    const [owner] = await db()
      .select({ kind: users.kind })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    if (owner?.kind === 'service') throw errors.unauthorized('Неверный логин или пароль')

    const env = config()
    const token = randomToken(32)
    const csrfToken = randomToken(24)
    const expiresAt = new Date(Date.now() + env.SESSION_ABSOLUTE_DAYS * 86_400_000).toISOString()

    await db()
      .insert(sessions)
      .values({
        id: newId(),
        userId,
        tokenHash: hashToken(token),
        csrfToken,
        ip: meta.ip,
        userAgent: meta.userAgent,
        deviceName: deviceNameFrom(meta.userAgent),
        mfaVerifiedAt: mfaVerified ? new Date().toISOString() : null,
        expiresAt,
      })

    return { sessionToken: token, csrfToken, userId, expiresAt }
  },

  async afterLogin(userId: string, meta: RequestMeta): Promise<void> {
    const sys = systemCtx('auth.login', { requestId: meta.requestId, initiatorId: userId })
    await db().update(users).set({ lastSeenAt: sql`now()` }).where(eq(users.id, userId))
    await audit(sys, {
      action: AUDIT_ACTIONS.login,
      actorId: userId,
      objectId: userId,
      objectType: 'user',
      ip: meta.ip,
      userAgent: meta.userAgent,
    })
    await db().transaction(async (tx) => {
      await publishEvent(tx, sys, {
        type: 'user.login',
        object: { id: userId, type: 'user' },
        payload: { ip: meta.ip, userAgent: meta.userAgent },
      })
    })
  },

  /** Проверка сессии при каждом запросе; продлевает активность. */
  async resolveSession(token: string): Promise<{
    sessionId: string
    userId: string
    csrfToken: string
    expiresAt: string
    onBehalfOf: string | null
    /** Второй фактор подключён — для проверки политики `requireMfaRoles`. */
    mfaEnrolled: boolean
    /** Режим администратора сессии (ADR-0080), если он включён и не истёк. */
    adminMode: { reason: string; until: string } | null
    lastActiveAt: string
  } | null> {
    const env = config()
    const [row] = await db()
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)))
      .limit(1)

    if (!row) return null
    if (new Date(row.expiresAt) < new Date()) return null

    // Простой сессии — из политики безопасности, иначе из конфигурации сервера
    const policy = await SecurityPolicyService.current()
    const idleLimitMs = (policy.sessionIdleHours ?? env.SESSION_IDLE_HOURS) * 3_600_000
    if (Date.now() - new Date(row.lastActiveAt).getTime() > idleLimitMs) {
      await db().update(sessions).set({ revokedAt: sql`now()` }).where(eq(sessions.id, row.id))
      return null
    }

    return {
      sessionId: row.id,
      userId: row.userId,
      csrfToken: row.csrfToken,
      expiresAt: row.expiresAt,
      onBehalfOf: row.onBehalfOf,
      lastActiveAt: row.lastActiveAt,
      // Отдельным запросом: коррелированный подзапрос в списке select drizzle
      // выводит без имён таблиц, и условие вырождается в user_id = user_id
      mfaEnrolled: await AuthService.mfaEnabled(row.userId),
      adminMode:
        row.adminModeUntil && new Date(row.adminModeUntil).getTime() > Date.now()
          ? { reason: row.adminModeReason ?? '', until: row.adminModeUntil }
          : null,
    }
  },

  /**
   * Режим администратора (ADR-0080): администратор системы с обоснованием на
   * ограниченное время видит объекты с грифом выше допуска. Живёт в сессии:
   * другой браузер или новый вход — без режима. Вход — в аудит.
   */
  async enterAdminMode(ctx: UserCtx, input: AdminModeInput): Promise<AdminModeState> {
    const until = new Date(Date.now() + input.minutes * 60_000).toISOString()
    await db()
      .update(sessions)
      .set({ adminModeUntil: until, adminModeReason: input.reason })
      .where(and(eq(sessions.id, ctx.sessionId), eq(sessions.userId, ctx.userId)))
    await audit(ctx, {
      action: AUDIT_ACTIONS.adminMode,
      objectId: ctx.userId,
      objectType: 'user',
      severity: 'warning',
      details: { reason: input.reason, minutes: input.minutes, until },
    })
    return { reason: input.reason, until }
  },

  async exitAdminMode(ctx: UserCtx): Promise<void> {
    const [row] = await db()
      .update(sessions)
      .set({ adminModeUntil: null, adminModeReason: null })
      .where(and(eq(sessions.id, ctx.sessionId), eq(sessions.userId, ctx.userId)))
      .returning({ id: sessions.id })
    if (!row) return
    await audit(ctx, {
      action: AUDIT_ACTIONS.adminModeExited,
      objectId: ctx.userId,
      objectType: 'user',
      severity: 'notice',
      details: { reason: ctx.adminMode?.reason ?? null },
    })
  },

  /** Допуск пользователя и режим администратора сессии — для контекста сокета. */
  async accessAttributesOf(session: {
    sessionId: string
    userId: string
  }): Promise<{ clearance: Confidentiality; adminMode: AdminModeState | null }> {
    const [[user], [row]] = await Promise.all([
      db()
        .select({ attributes: users.attributes })
        .from(users)
        .where(eq(users.id, session.userId))
        .limit(1),
      db()
        .select({ until: sessions.adminModeUntil, reason: sessions.adminModeReason })
        .from(sessions)
        .where(and(eq(sessions.id, session.sessionId), isNull(sessions.revokedAt)))
        .limit(1),
    ])
    return {
      clearance: parseConfidentiality(user?.attributes.clearance),
      adminMode:
        row?.until && new Date(row.until).getTime() > Date.now()
          ? { reason: row.reason ?? '', until: row.until }
          : null,
    }
  },

  async touchSession(sessionId: string): Promise<void> {
    await db().update(sessions).set({ lastActiveAt: sql`now()` }).where(eq(sessions.id, sessionId))
  },

  async logout(ctx: UserCtx): Promise<void> {
    await db().update(sessions).set({ revokedAt: sql`now()` }).where(eq(sessions.id, ctx.sessionId))
    await audit(ctx, { action: AUDIT_ACTIONS.logout, objectId: ctx.userId, objectType: 'user' })
    await db().transaction(async (tx) => {
      await publishEvent(tx, ctx, { type: 'user.logout', object: { id: ctx.userId, type: 'user' } })
    })
  },

  async revokeSessions(ctx: UserCtx, sessionIds: string[]): Promise<number> {
    if (sessionIds.length === 0) return 0
    const revoked = await db()
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(sessions.userId, ctx.userId), sql`${sessions.id} = ANY(${sessionIds})`))
      .returning({ id: sessions.id })
    await audit(ctx, {
      action: AUDIT_ACTIONS.sessionRevoked,
      details: { count: revoked.length },
      severity: 'notice',
    })
    return revoked.length
  },

  async revokeAllExcept(userId: string, keepSessionId: string | null): Promise<number> {
    const revoked = await db()
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          keepSessionId ? sql`${sessions.id} <> ${keepSessionId}` : sql`true`,
        ),
      )
      .returning({ id: sessions.id })
    return revoked.length
  },

  async listSessions(userId: string, currentSessionId: string) {
    const rows = await db()
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .orderBy(sql`${sessions.lastActiveAt} desc`)
    return rows.map((row) => ({
      id: row.id,
      ip: row.ip,
      userAgent: row.userAgent,
      deviceName: row.deviceName,
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt,
      expiresAt: row.expiresAt,
      current: row.id === currentSessionId,
    }))
  },

  // ── Пароль ────────────────────────────────────────────────────────────────

  async changePassword(
    ctx: UserCtx,
    currentPassword: string,
    newPassword: string,
    revokeOthers: boolean,
  ): Promise<void> {
    const [cred] = await db()
      .select()
      .from(credentials)
      .where(eq(credentials.userId, ctx.userId))
      .limit(1)
    if (!cred) throw errors.notFound('Учётные данные')
    if (!(await verifyPassword(cred.passwordHash, currentPassword))) {
      throw errors.validation('Текущий пароль неверен', [
        { path: 'currentPassword', message: 'Текущий пароль неверен' },
      ])
    }
    await AuthService.setPassword(ctx.userId, newPassword)
    if (revokeOthers) await AuthService.revokeAllExcept(ctx.userId, ctx.sessionId)

    await audit(ctx, {
      action: AUDIT_ACTIONS.passwordChanged,
      objectId: ctx.userId,
      objectType: 'user',
      severity: 'notice',
    })
    await db().transaction(async (tx) => {
      await publishEvent(tx, ctx, {
        type: 'user.password_changed',
        object: { id: ctx.userId, type: 'user' },
      })
    })
  },

  /**
   * `tx` обязателен, когда пользователь создаётся в той же транзакции.
   * Логин для проверки «пароль не содержит логин» берётся из учётной записи,
   * если его не передали (смена пароля, восстановление по ссылке).
   */
  async setPassword(
    userId: string,
    password: string,
    login?: string,
    tx: Executor = db(),
  ): Promise<void> {
    const [account] = await tx
      .select({ login: users.login, kind: users.kind })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    // Служебная учётная запись не входит в систему — пароля у неё нет (ADR-0130)
    if (account?.kind === 'service') {
      throw errors.validation('У служебной учётной записи нет пароля: она не входит в систему')
    }
    const policy = checkPasswordPolicy(password, login ?? account?.login)
    if (!policy.ok) {
      throw errors.validation('Пароль не соответствует политике', [
        { path: 'newPassword', message: policy.messageKey ?? 'auth.password.tooSimple' },
      ])
    }

    const [cred] = await tx
      .select()
      .from(credentials)
      .where(eq(credentials.userId, userId))
      .limit(1)
    if (cred) {
      for (const previous of cred.history.slice(-PASSWORD_HISTORY)) {
        if (await verifyPassword(previous, password)) {
          throw errors.validation('Этот пароль уже использовался', [
            { path: 'newPassword', message: 'auth.password.reused' },
          ])
        }
      }
    }

    const hash = await hashPassword(password)
    const history = [...(cred?.history ?? []), cred?.passwordHash]
      .filter(Boolean)
      .slice(-PASSWORD_HISTORY) as string[]

    if (cred) {
      await tx
        .update(credentials)
        .set({
          passwordHash: hash,
          history,
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: sql`now()`,
        })
        .where(eq(credentials.userId, userId))
    } else {
      await tx.insert(credentials).values({ userId, passwordHash: hash, history: [] })
    }

    await tx
      .update(users)
      .set({ passwordChangedAt: sql`now()`, mustChangePassword: false })
      .where(eq(users.id, userId))
    await invalidatePrincipalSet(userId)
  },

  async requestPasswordReset(login: string): Promise<{ token: string; userId: string } | null> {
    const [user] = await db()
      .select({ id: users.id, status: users.status, kind: users.kind })
      .from(users)
      .where(
        or(
          sql`lower(${users.login}) = ${login.toLowerCase()}`,
          sql`lower(${users.email}) = ${login.toLowerCase()}`,
        ),
      )
      .limit(1)
    // Служебной учётной записи пароль не восстанавливают: его нет (ADR-0130)
    if (user?.status !== 'active' || user.kind === 'service') return null

    const token = randomToken(32)
    await db()
      .insert(passwordResets)
      .values({
        id: newId(),
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_MINUTES * 60_000).toISOString(),
      })
    return { token, userId: user.id }
  },

  async confirmPasswordReset(token: string, newPassword: string): Promise<string> {
    const [row] = await db()
      .select()
      .from(passwordResets)
      .where(
        and(
          eq(passwordResets.tokenHash, hashToken(token)),
          isNull(passwordResets.usedAt),
          gt(passwordResets.expiresAt, sql`now()`),
        ),
      )
      .limit(1)
    if (!row) throw errors.validation('Ссылка недействительна или истекла')

    // Отключённая после запроса учётная запись доступ по ссылке не возвращает
    const [user] = await db()
      .select({ status: users.status, kind: users.kind })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1)
    if (user?.status !== 'active' || user.kind === 'service') {
      throw errors.validation('Ссылка недействительна или истекла')
    }

    await AuthService.setPassword(row.userId, newPassword)
    await db()
      .update(passwordResets)
      .set({ usedAt: sql`now()` })
      .where(eq(passwordResets.id, row.id))
    await AuthService.revokeAllExcept(row.userId, null)
    return row.userId
  },

  // ── MFA ───────────────────────────────────────────────────────────────────

  async startMfaSetup(ctx: UserCtx): Promise<{ secret: string; otpauthUrl: string }> {
    // 160 бит: RFC 4226 §4 требует не меньше 128 и рекомендует 160 (у otplib по умолчанию 80)
    const secret = authenticator.generateSecret(20)
    const issuer = PRODUCT_NAME
    const otpauthUrl = authenticator.keyuri(ctx.displayName || ctx.userId, issuer, secret)

    await db()
      .delete(mfaFactors)
      .where(and(eq(mfaFactors.userId, ctx.userId), isNull(mfaFactors.verifiedAt)))
    await db()
      .insert(mfaFactors)
      .values({
        id: newId(),
        userId: ctx.userId,
        kind: 'totp',
        secretEnc: encryptSecret(secret),
        name: 'Приложение-аутентификатор',
      })
    return { secret, otpauthUrl }
  },

  async enableMfa(ctx: UserCtx, code: string): Promise<string[]> {
    const ok = await AuthService.verifyTotp(ctx.userId, code)
    if (!ok)
      throw errors.validation('Неверный код', [{ path: 'code', message: 'auth.mfa.invalid' }])

    const codes = Array.from({ length: 10 }, () => `${randomCode(5)}-${randomCode(5)}`)
    await db().delete(recoveryCodes).where(eq(recoveryCodes.userId, ctx.userId))
    await db()
      .insert(recoveryCodes)
      .values(
        codes.map((code) => ({
          id: newId(),
          userId: ctx.userId,
          codeHash: hashToken(code.replace('-', '')),
        })),
      )

    await audit(ctx, {
      action: AUDIT_ACTIONS.mfaEnabled,
      objectId: ctx.userId,
      objectType: 'user',
      severity: 'notice',
    })
    await db().transaction(async (tx) => {
      await publishEvent(tx, ctx, {
        type: 'user.mfa_enabled',
        object: { id: ctx.userId, type: 'user' },
        payload: { kind: 'totp' },
      })
    })
    return codes
  },

  async disableMfa(ctx: UserCtx, userId: string): Promise<void> {
    await db().delete(mfaFactors).where(eq(mfaFactors.userId, userId))
    await db().delete(recoveryCodes).where(eq(recoveryCodes.userId, userId))
    await audit(ctx, {
      action: AUDIT_ACTIONS.mfaDisabled,
      objectId: userId,
      objectType: 'user',
      severity: 'warning',
    })
    await db().transaction(async (tx) => {
      await publishEvent(tx, ctx, {
        type: 'user.mfa_disabled',
        object: { id: userId, type: 'user' },
        payload: { kind: 'totp' },
      })
    })
  },

  /**
   * Подключён ли второй фактор. Ключ входа (passkey) считается наравне с TOTP
   * (ADR-0098): подтверждение на устройстве — такой же второй фактор.
   */
  async mfaEnabled(userId: string): Promise<boolean> {
    return (await AuthService.secondFactorMethods(userId)).length > 0
  },

  /**
   * Чем пользователь может подтвердить второй фактор. Один запрос: он идёт на
   * каждом обращении к API (проверка сессии), и лишний обход базы там заметен.
   */
  async secondFactorMethods(userId: string): Promise<SecondFactorMethod[]> {
    const rows = await db().execute<{ totp: boolean; passkey: boolean }>(sql`
      SELECT
        EXISTS (
          SELECT 1 FROM ${mfaFactors}
           WHERE ${mfaFactors.userId} = ${userId} AND ${mfaFactors.verifiedAt} IS NOT NULL
        ) AS totp,
        EXISTS (
          SELECT 1 FROM ${webauthnCredentials} WHERE ${webauthnCredentials.userId} = ${userId}
        ) AS passkey`)
    const row = rows[0]
    const methods: SecondFactorMethod[] = []
    if (row?.totp) methods.push('totp', 'recovery_code')
    if (row?.passkey) methods.push('passkey')
    return methods
  },
}

/**
 * Проверка пароля в каталоге (ADR-0098): запись ищется заново, отключённая в
 * каталоге не пускается, и только затем выполняется привязка под её DN.
 * Любая ошибка каталога — отказ во входе, а не пропуск проверки.
 */
async function verifyDirectoryPassword(
  login: string,
  knownDn: string | null,
  password: string,
): Promise<boolean> {
  try {
    const { enabled, settings, bindPassword } = await AuthProviders.directory()
    if (!enabled || !settings.allowPasswordLogin) return false

    const entry = await LdapClient.findUser(settings, bindPassword, login)
    // Запись пропала из каталога — вход по паролю каталога больше не работает
    if (!entry) return false
    if (entryDisabled(entry, settings.attributes.disabled)) return false

    const dn = entry.dn || knownDn
    if (!dn) return false
    return await LdapClient.bindAs(settings, dn, password)
  } catch {
    return false
  }
}

function deviceNameFrom(userAgent: string | null): string | null {
  if (!userAgent) return null
  const ua = userAgent.toLowerCase()
  const os = ua.includes('windows')
    ? 'Windows'
    : ua.includes('mac os')
      ? 'macOS'
      : ua.includes('android')
        ? 'Android'
        : ua.includes('iphone') || ua.includes('ipad')
          ? 'iOS'
          : ua.includes('linux')
            ? 'Linux'
            : null
  const browser = ua.includes('edg/')
    ? 'Edge'
    : ua.includes('chrome')
      ? 'Chrome'
      : ua.includes('firefox')
        ? 'Firefox'
        : ua.includes('safari')
          ? 'Safari'
          : null
  return [browser, os].filter(Boolean).join(' · ') || null
}
