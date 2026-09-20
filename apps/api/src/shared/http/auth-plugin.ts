import { type AdminModeState, REPORT_PRINT } from '@kchs/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { config } from '../config/index.js'
import type { UserCtx } from '../context.js'
import { AppError, errors } from '../errors.js'
import type { RouteAuth } from './route.js'

declare module 'fastify' {
  interface FastifyRequest {
    ctx: UserCtx
  }
  interface FastifyContextConfig {
    auth?: RouteAuth
    /** Теги маршрута: по ним определяется область доступа токена API (ADR-0097). */
    apiTags?: string[]
    allowPendingPasswordChange?: boolean
    allowPendingMfaEnrollment?: boolean
    /** POST без изменения данных (запрос к датасету): доступен странице печати. */
    readOnly?: boolean
  }
}

export interface AuthDependencies {
  resolveSession: (token: string) => Promise<{
    sessionId: string
    userId: string
    csrfToken: string
    expiresAt: string
    onBehalfOf: string | null
    mfaEnrolled: boolean
    adminMode?: AdminModeState | null
  } | null>
  buildUserCtx: (
    session: {
      sessionId: string
      userId: string
      onBehalfOf: string | null
      mfaEnrolled: boolean
      adminMode?: AdminModeState | null
    },
    request: FastifyRequest,
  ) => Promise<UserCtx>
  touchSession: (sessionId: string) => Promise<void>
  authorizeRoute: (ctx: UserCtx, action: string, objectId: string) => Promise<void>
  requireCapability: (ctx: UserCtx, capability: string) => void
  resolveShareLink?: (token: string) => Promise<UserCtx | null>
  /** Служебный токен страницы печати (cookie `kchs_print`, ADR-0078). */
  resolvePrintGrant?: (token: string) => Promise<UserCtx | null>
  /**
   * Токен публичного API (`Authorization: Bearer …`, ADR-0097): строит контекст
   * владельца токена. Бросает 401/403/429 — наружу уходит обычная проблема API.
   */
  resolveApiToken?: (request: FastifyRequest, secret: string) => Promise<UserCtx>
  /** Проверка области доступа токена для конкретного маршрута (ADR-0097). */
  enforceTokenScope?: (request: FastifyRequest) => Promise<void>
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `Authorization: Bearer <token>` — иные схемы игнорируются. */
function bearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match?.[1] ?? null
}

/**
 * Аутентификация и применение политики маршрута.
 * Маршрут без `config.auth` не обслуживается: это защита от «забыли проверить»
 * (17-security.md §3).
 */
export const authPlugin = fp<AuthDependencies>(async (app: FastifyInstance, deps) => {
  const env = config()

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.routeOptions?.config?.auth as RouteAuth | undefined

    if (auth === undefined) {
      // Неизвестный маршрут (404) или маршрут без политики
      if (request.routeOptions?.url) {
        request.log.error({ url: request.url }, 'маршрут без политики auth')
        throw errors.internal('Маршрут без политики доступа')
      }
      return
    }

    if (auth === 'public') return

    // Токен публичного API идёт раньше сессии: интеграция ходит без cookie,
    // CSRF ей не нужен (17-security.md §5), а области проверяются отдельно
    const bearer = bearerToken(request.headers.authorization)
    if (bearer && deps.resolveApiToken) {
      request.ctx = await deps.resolveApiToken(request, bearer)
      await deps.enforceTokenScope?.(request)
      await applyRoutePolicy(request, auth, deps)
      return
    }

    const token = request.cookies?.[env.SESSION_COOKIE_NAME]
    const shareToken = request.headers['x-kchs-share-token']

    if (!token && typeof shareToken === 'string' && deps.resolveShareLink) {
      const guestCtx = await deps.resolveShareLink(shareToken)
      if (guestCtx) {
        // Гость видит один объект и только читает его (ADR-0032): маршруты
        // сессии, способностей и любые изменения для него не существуют
        if (!SAFE_METHODS.has(request.method) || typeof auth !== 'object' || !('action' in auth)) {
          throw errors.notFound()
        }
        request.ctx = { ...guestCtx, requestId: request.id }
        await applyRoutePolicy(request, auth, deps)
        return
      }
    }

    // Страница печати в Chromium движка (ADR-0078): cookie служебного токена
    // вместо сессии, права — того, под кем строится документ, только чтение
    const printToken = request.cookies?.[REPORT_PRINT.cookie]
    if (!token && typeof printToken === 'string' && deps.resolvePrintGrant) {
      const printCtx = await deps.resolvePrintGrant(printToken)
      if (!printCtx) throw errors.unauthorized('Токен печати недействителен или истёк')
      // Личные маршруты (профиль, сессия, вход) живут сессией — у печати её нет
      const personal = /^\/api\/v1\/(me|auth)(\/|$)/.test(request.routeOptions?.url ?? '')
      if (
        personal ||
        (!SAFE_METHODS.has(request.method) && !request.routeOptions?.config?.readOnly)
      ) {
        throw errors.forbidden('Страница печати только читает данные')
      }
      request.ctx = { ...printCtx, requestId: request.id }
      await applyRoutePolicy(request, auth, deps)
      return
    }

    if (!token) throw errors.unauthorized()

    const session = await deps.resolveSession(token)
    if (!session) {
      reply.clearCookie(env.SESSION_COOKIE_NAME, { path: '/' })
      throw errors.unauthorized('Сессия истекла, войдите заново')
    }

    // CSRF для изменяющих запросов от браузера (17-security.md §5)
    if (!SAFE_METHODS.has(request.method)) {
      const header = request.headers['x-csrf-token']
      if (typeof header !== 'string' || header !== session.csrfToken) {
        throw errors.forbidden('Некорректный CSRF-токен')
      }
    }

    request.ctx = await deps.buildUserCtx(session, request)
    void deps.touchSession(session.sessionId)

    // Незавершённая настройка входа (17-security.md §2): сначала временный пароль,
    // затем обязательный второй фактор — маршрут смены пароля не требует MFA
    const setup = request.routeOptions?.config
    if (request.ctx.mustChangePassword) {
      if (!setup?.allowPendingPasswordChange) {
        throw new AppError('password_change_required', 'Смените временный пароль', 403)
      }
    } else if (request.ctx.mfaEnrollmentRequired && !setup?.allowPendingMfaEnrollment) {
      throw new AppError(
        'mfa_enrollment_required',
        'Подключите второй фактор: этого требует политика безопасности для вашей роли',
        403,
      )
    }

    await applyRoutePolicy(request, auth, deps)
  })
})

async function applyRoutePolicy(
  request: FastifyRequest,
  auth: RouteAuth,
  deps: AuthDependencies,
): Promise<void> {
  if (auth === 'session' || auth === 'public') return

  if ('capability' in auth && !('action' in auth)) {
    deps.requireCapability(request.ctx, auth.capability)
    return
  }

  if ('action' in auth) {
    const param = auth.objectParam ?? 'id'
    const params = request.params as Record<string, string> | undefined
    const objectId = params?.[param]
    if (!objectId) throw errors.validation(`В маршруте отсутствует параметр «${param}»`)
    // Проверка прав идёт до валидации схемы: чужой формат идентификатора — «не найдено»
    if (!UUID_RE.test(objectId)) throw errors.notFound()
    if (auth.capability) deps.requireCapability(request.ctx, auth.capability)
    await deps.authorizeRoute(request.ctx, auth.action, objectId)
  }
}
