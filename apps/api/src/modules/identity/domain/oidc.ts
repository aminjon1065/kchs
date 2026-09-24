import type { SsoSettings, SsoTestResult } from '@kchs/contracts'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import * as oidc from 'openid-client'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { config } from '~/shared/config/index.js'
import { systemCtx } from '~/shared/context.js'
import { decryptSecret, encryptSecret, hashToken } from '~/shared/crypto/secrets.js'
import { db } from '~/shared/db/client.js'
import {
  roles,
  ssoAuthRequests,
  ssoIdentities,
  userRoles,
  users,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId, randomToken } from '~/shared/ids.js'
import { AuthProviders, OIDC_PROVIDER } from './auth-providers.js'
import { AuthService, type RequestMeta } from './auth-service.js'
import { UserService } from './user-service.js'

/**
 * Единый вход через корпоративный IdP (ADR-0098): Authorization Code + PKCE.
 *
 * Состояние незавершённого входа живёт в базе, а не в cookie: `state` хранится
 * хэшем, проверочный код PKCE — зашифрованным, строка одноразовая и живёт
 * минуты. Чужой `state` не находится, повторный — уже использован, просроченный
 * отсеивается сроком. `nonce` сверяется с id_token библиотекой.
 */

const REQUEST_MINUTES = 10
const DISCOVERY_TTL_MS = 300_000

let discovered: { key: string; at: number; value: oidc.Configuration } | null = null

/** Адрес возврата, который прописывают в IdP. */
export function redirectUri(): string {
  return `${config().KCHS_BASE_URL.replace(/\/+$/, '')}/api/v1/auth/sso/callback`
}

async function configuration(
  settings: SsoSettings,
  clientSecret: string | null,
): Promise<oidc.Configuration> {
  if (!settings.issuer) throw errors.validation('Адрес издателя не задан')
  if (!settings.clientId) throw errors.validation('Идентификатор клиента не задан')
  const key = `${settings.issuer}|${settings.clientId}|${clientSecret ? '1' : '0'}|${settings.allowInsecureHttp}`
  if (discovered && discovered.key === key && Date.now() - discovered.at < DISCOVERY_TTL_MS) {
    return discovered.value
  }
  const value = await oidc.discovery(
    new URL(settings.issuer),
    settings.clientId,
    clientSecret ?? undefined,
    clientSecret ? oidc.ClientSecretPost(clientSecret) : oidc.None(),
    // http допускается только явной настройкой: внутренний стенд и тесты
    settings.allowInsecureHttp ? { execute: [oidc.allowInsecureRequests] } : undefined,
  )
  discovered = { key, at: Date.now(), value }
  return value
}

/** Сброс кэша обнаружения: после смены настроек и в тестах. */
export function resetDiscoveryCache(): void {
  discovered = null
}

function claimString(claims: Record<string, unknown>, name: string): string | null {
  if (!name) return null
  const value = claims[name]
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number') return String(value)
  return null
}

function claimGroups(claims: Record<string, unknown>, name: string): string[] {
  if (!name) return []
  const value = claims[name]
  if (Array.isArray(value)) return value.map((item) => String(item).toLowerCase().trim())
  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((item) => item.toLowerCase().trim())
      .filter(Boolean)
  }
  return []
}

function normalizeLogin(raw: string): string {
  const withoutDomain = raw.includes('@') ? (raw.split('@')[0] ?? raw) : raw
  return withoutDomain
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .slice(0, 64)
    .toLowerCase()
}

export const SsoService = {
  /** Настроен ли вход через IdP — для экрана входа; адреса наружу не уходят. */
  async available(): Promise<{ enabled: boolean; buttonLabel: string }> {
    const { enabled, settings } = await AuthProviders.sso()
    return {
      enabled: enabled && Boolean(settings.issuer && settings.clientId),
      buttonLabel: settings.buttonLabel,
    }
  },

  /** Проверка соединения: чтение конфигурации издателя. */
  async test(): Promise<SsoTestResult> {
    const started = Date.now()
    const { settings, clientSecret } = await AuthProviders.sso()
    try {
      resetDiscoveryCache()
      const server = (await configuration(settings, clientSecret)).serverMetadata()
      return {
        ok: true,
        error: null,
        issuer: server.issuer,
        authorizationEndpoint: server.authorization_endpoint ?? null,
        tokenEndpoint: server.token_endpoint ?? null,
        endSessionEndpoint: server.end_session_endpoint ?? null,
        elapsedMs: Date.now() - started,
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 300) : 'неизвестная ошибка',
        issuer: null,
        authorizationEndpoint: null,
        tokenEndpoint: null,
        endSessionEndpoint: null,
        elapsedMs: Date.now() - started,
      }
    }
  },

  /** Начало входа: строка состояния сохраняется, браузер уходит на IdP. */
  async start(meta: RequestMeta): Promise<{ url: string }> {
    const { enabled, settings, clientSecret } = await AuthProviders.sso()
    if (!enabled) throw errors.validation('Единый вход не подключён')
    const configured = await configuration(settings, clientSecret)

    const state = oidc.randomState()
    const nonce = oidc.randomNonce()
    const codeVerifier = oidc.randomPKCECodeVerifier()
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier)

    await db()
      .insert(ssoAuthRequests)
      .values({
        id: newId(),
        provider: OIDC_PROVIDER,
        stateHash: hashToken(state),
        nonce,
        codeVerifierEnc: encryptSecret(codeVerifier),
        ip: meta.ip,
        userAgent: meta.userAgent,
        expiresAt: new Date(Date.now() + REQUEST_MINUTES * 60_000).toISOString(),
      })

    const url = oidc.buildAuthorizationUrl(configured, {
      redirect_uri: redirectUri(),
      scope: settings.scopes,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })
    return { url: url.href }
  },

  /**
   * Возврат от IdP: обмен кода на токены и вход. Любая неувязка — отказ без
   * подробностей: по сообщению нельзя понять, есть ли такая учётная запись.
   */
  async callback(
    query: Record<string, string>,
    meta: RequestMeta,
  ): Promise<{ sessionToken: string; csrfToken: string; expiresAt: string; userId: string }> {
    const { enabled, settings, clientSecret } = await AuthProviders.sso()
    if (!enabled) throw errors.validation('Единый вход не подключён')

    const state = query.state ?? ''
    if (!state) throw errors.unauthorized('Вход не завершён, попробуйте снова')

    // Строка состояния одноразовая: отметка о применении ставится сразу и
    // условием на `used_at`, поэтому повтор того же ответа IdP не проходит
    const [request] = await db()
      .update(ssoAuthRequests)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(ssoAuthRequests.stateHash, hashToken(state)),
          eq(ssoAuthRequests.provider, OIDC_PROVIDER),
          isNull(ssoAuthRequests.usedAt),
          gt(ssoAuthRequests.expiresAt, sql`now()`),
        ),
      )
      .returning()
    if (!request) throw errors.unauthorized('Вход не завершён, попробуйте снова')

    const configured = await configuration(settings, clientSecret)
    const current = new URL(redirectUri())
    for (const [key, value] of Object.entries(query)) current.searchParams.set(key, value)

    let claims: Record<string, unknown>
    try {
      const tokens = await oidc.authorizationCodeGrant(configured, current, {
        pkceCodeVerifier: decryptSecret(request.codeVerifierEnc),
        expectedNonce: request.nonce,
        expectedState: state,
      })
      claims = (tokens.claims() ?? {}) as Record<string, unknown>
    } catch {
      await audit(systemCtx('auth.sso', { requestId: meta.requestId }), {
        action: AUDIT_ACTIONS.loginFailed,
        details: { provider: OIDC_PROVIDER, reason: 'token_exchange_failed' },
        severity: 'warning',
        ip: meta.ip,
        userAgent: meta.userAgent,
      })
      throw errors.unauthorized('Вход не завершён, попробуйте снова')
    }

    const subject = claimString(claims, 'sub')
    if (!subject) throw errors.unauthorized('Вход не завершён, попробуйте снова')

    const userId = await resolveUser(settings, subject, claims, meta)
    const session = await AuthService.createSession(userId, meta, true)
    await AuthService.afterLogin(userId, meta)
    await audit(systemCtx('auth.sso', { requestId: meta.requestId, initiatorId: userId }), {
      action: AUDIT_ACTIONS.loginExternal,
      actorId: userId,
      objectId: userId,
      objectType: 'user',
      details: { provider: OIDC_PROVIDER },
      severity: 'notice',
      ip: meta.ip,
      userAgent: meta.userAgent,
    })
    return { ...session, userId }
  },

  /** Адрес завершения сессии IdP; null — выход только из платформы. */
  async endSessionUrl(): Promise<string | null> {
    const { enabled, settings, clientSecret } = await AuthProviders.sso()
    if (!enabled || !settings.endSessionOnLogout) return null
    try {
      const configured = await configuration(settings, clientSecret)
      if (!configured.serverMetadata().end_session_endpoint) return null
      return oidc.buildEndSessionUrl(configured, {
        post_logout_redirect_uri: config().KCHS_BASE_URL,
      }).href
    } catch {
      // Недоступный IdP не должен мешать выйти из платформы
      return null
    }
  },
}

async function resolveUser(
  settings: SsoSettings,
  subject: string,
  claims: Record<string, unknown>,
  meta: RequestMeta,
): Promise<string> {
  const sys = systemCtx('auth.sso', { requestId: meta.requestId })

  const [identity] = await db()
    .select({ userId: ssoIdentities.userId })
    .from(ssoIdentities)
    .where(and(eq(ssoIdentities.provider, OIDC_PROVIDER), eq(ssoIdentities.subject, subject)))
    .limit(1)

  const map = settings.claims
  const rawLogin = claimString(claims, map.login) ?? claimString(claims, map.email) ?? subject
  const login = normalizeLogin(rawLogin)
  const email = claimString(claims, map.email)
  const displayName = claimString(claims, map.displayName) ?? ''
  const parts = displayName.split(/\s+/).filter(Boolean)
  const lastName = claimString(claims, map.lastName) ?? parts[0] ?? login
  const firstName = claimString(claims, map.firstName) ?? parts[1] ?? login

  const groups = claimGroups(claims, map.groups)
  const mapped = settings.groupMappings
    .filter((mapping) => groups.includes(mapping.group.toLowerCase().trim()))
    .map((mapping) => mapping.roleKey)
  const knownRoles = new Set((await db().select({ key: roles.key }).from(roles)).map((r) => r.key))
  const roleKeys = [...new Set(mapped.length > 0 ? mapped : settings.defaultRoleKeys)].filter(
    (key) => knownRoles.has(key),
  )

  if (identity) {
    await assertActive(identity.userId, meta)
    // Правка — только при настоящем изменении: иначе каждый вход писал бы в
    // аудит смену ролей и публиковал событие обновления пользователя
    const patch = await changedFields(identity.userId, { email, roleKeys })
    if (patch) await db().transaction((tx) => UserService.patch(tx, sys, identity.userId, patch))
    return identity.userId
  }

  // Учётная запись уже заведена: связываем её с субъектом IdP
  const [existing] = await db()
    .select({ id: users.id, kind: users.kind })
    .from(users)
    .where(
      email
        ? sql`lower(${users.login}) = ${login} or lower(${users.email}) = ${email.toLowerCase()}`
        : sql`lower(${users.login}) = ${login}`,
    )
    .limit(1)

  // Служебная учётная запись (ADR-0130) с субъектом IdP не связывается: войти ею нельзя,
  // а совпадение логина или почты не должно открыть её человеку
  if (existing?.kind === 'service') {
    await audit(sys, {
      action: AUDIT_ACTIONS.loginFailed,
      actorId: existing.id,
      details: { provider: OIDC_PROVIDER, reason: 'service_account', login },
      severity: 'warning',
      ip: meta.ip,
      userAgent: meta.userAgent,
    })
    throw errors.unauthorized('Учётная запись не заведена. Обратитесь к администратору')
  }

  if (existing) {
    await assertActive(existing.id, meta)
    await link(existing.id, subject, claims, sys)
    return existing.id
  }

  if (!settings.jitCreate) {
    await audit(sys, {
      action: AUDIT_ACTIONS.loginFailed,
      details: { provider: OIDC_PROVIDER, reason: 'no_account', login },
      severity: 'warning',
      ip: meta.ip,
      userAgent: meta.userAgent,
    })
    throw errors.unauthorized('Учётная запись не заведена. Обратитесь к администратору')
  }
  if (login.length < 3) throw errors.unauthorized('Вход не завершён, попробуйте снова')

  const id = await db().transaction(async (tx) => {
    const created = await UserService.create(tx, sys, {
      login,
      email,
      lastName: lastName.slice(0, 100),
      firstName: firstName.slice(0, 100),
      middleName: claimString(claims, map.middleName)?.slice(0, 100) ?? null,
      roleKeys: roleKeys.length > 0 ? roleKeys : ['employee'],
      // Локального пароля у учётной записи IdP нет: вход только через провайдера
      password: `oidc-${randomToken(24)}-Aa1!`,
      mustChangePassword: false,
      locale: 'ru',
      timezone: 'Asia/Dushanbe',
    })
    await tx.update(users).set({ authSource: OIDC_PROVIDER }).where(eq(users.id, created.id))
    return created.id
  })
  await link(id, subject, claims, sys)
  return id
}

/**
 * Что действительно меняется у уже связанного сотрудника: почта и набор ролей.
 * Ничего не изменилось — `null`, и запись в базу не идёт.
 */
async function changedFields(
  userId: string,
  next: { email: string | null; roleKeys: string[] },
): Promise<{ email?: string; roleKeys?: string[] } | null> {
  const [current] = await db()
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  const currentRoles = (
    await db()
      .select({ key: roles.key })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, userId))
  ).map((row) => row.key)

  const patch: { email?: string; roleKeys?: string[] } = {}
  if (next.email && next.email !== current?.email) patch.email = next.email
  const wanted = [...next.roleKeys].sort()
  if (wanted.length > 0 && wanted.join(',') !== [...currentRoles].sort().join(',')) {
    patch.roleKeys = next.roleKeys
  }
  return Object.keys(patch).length > 0 ? patch : null
}

async function link(
  userId: string,
  subject: string,
  claims: Record<string, unknown>,
  sys: ReturnType<typeof systemCtx>,
): Promise<void> {
  await db()
    .insert(ssoIdentities)
    .values({
      id: newId(),
      userId,
      provider: OIDC_PROVIDER,
      subject,
      // Полезные для разбора поля; токенов и секретов здесь нет
      profile: { sub: subject, iss: claims.iss ?? null },
    })
    .onConflictDoNothing()
  await db().transaction(async (tx) => {
    await publishEvent(tx, sys, {
      type: 'user.identity_linked',
      object: { id: userId, type: 'user' },
      payload: { userId, provider: OIDC_PROVIDER },
    })
  })
}

async function assertActive(userId: string, meta: RequestMeta): Promise<void> {
  const [user] = await db()
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (user?.status === 'active') return
  await audit(systemCtx('auth.sso', { requestId: meta.requestId }), {
    action: AUDIT_ACTIONS.loginFailed,
    actorId: userId,
    details: { provider: OIDC_PROVIDER, reason: `status_${user?.status ?? 'unknown'}` },
    severity: 'warning',
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
  throw errors.unauthorized('Учётная запись отключена. Обратитесь к администратору')
}
