import { scopeSatisfied } from '@kchs/contracts'
import type { FastifyRequest } from 'fastify'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { buildUserCtx } from '~/kernel/context-builder.js'
import { AuthService } from '~/modules/identity/public.js'
import { config } from '~/shared/config/index.js'
import type { UserCtx } from '~/shared/context.js'
import { systemCtx } from '~/shared/context.js'
import { errors } from '~/shared/errors.js'
import { hitRateLimit } from '~/shared/http/rate-limit.js'
import { ApiTokens } from './api-tokens.js'
import { requiredScope } from './scopes.js'

/** Сколько недействительных токенов в минуту принимается с одного адреса. */
const BAD_TOKEN_ATTEMPTS_PER_MINUTE = 60

/**
 * Аутентификация токеном публичного API (14-automation-integrations.md §3,
 * ADR-0097). Правила:
 *
 *  - токен не расширяет права: контекст строится по владельцу токена и дальше
 *    работает обычный `authorize()`;
 *  - область проверяется на каждом маршруте, список областей закрыт по
 *    умолчанию — маршрут без отображения тега токенам недоступен;
 *  - отозванный, просроченный токен и токен отключённого пользователя не
 *    работают; незавершённая настройка входа (временный пароль, обязательный
 *    второй фактор) тоже закрывает токен;
 *  - `x-kchs-on-behalf-of` с токеном не принимается: замещение — право
 *    человека в браузере, а не машины.
 */
export async function authenticateApiToken(
  request: FastifyRequest,
  secret: string,
): Promise<UserCtx> {
  const token = await ApiTokens.resolve(secret)
  if (!token) {
    // Недействительный токен отклоняется до общего лимита запросов (тот считает
    // по пользователю и работает уже после аутентификации), поэтому подбор и
    // поток записей в аудит ограничиваются здесь — по адресу клиента
    const attempts = await hitRateLimit(
      'api-token-bad',
      request.ip ?? 'anonymous',
      BAD_TOKEN_ATTEMPTS_PER_MINUTE,
      60,
    )
    if (!attempts.allowed) throw errors.rateLimited(attempts.retryAfter)
    await audit(systemCtx('api-token'), {
      action: AUDIT_ACTIONS.apiTokenRejected,
      severity: 'warning',
      objectType: 'api_token',
      ip: request.ip ?? null,
      details: { url: request.url, reason: 'invalid' },
    })
    throw errors.unauthorized('Токен недействителен')
  }

  if (request.headers['x-kchs-on-behalf-of']) {
    throw errors.forbidden('Замещение недоступно токенам API', { reason: 'token_on_behalf_of' })
  }

  const limit = token.rateLimitPerMinute ?? config().API_TOKEN_RATE_LIMIT_PER_MINUTE
  const hit = await hitRateLimit('api-token', token.id, limit, 60)
  if (!hit.allowed) throw errors.rateLimited(hit.retryAfter)

  const mfaEnrolled = await AuthService.mfaEnabled(token.userId)
  const ctx = await buildUserCtx(
    { sessionId: `token:${token.id}`, userId: token.userId, onBehalfOf: null, mfaEnrolled },
    request,
  )
  // Режим администратора живёт в сессии браузера — токену он не достаётся
  const tokenCtx: UserCtx = {
    ...ctx,
    adminMode: null,
    apiToken: { id: token.id, name: token.name, scopes: token.scopes },
  }
  if (tokenCtx.mustChangePassword) {
    throw errors.forbidden('Владелец токена не сменил временный пароль', {
      reason: 'password_change_required',
    })
  }
  if (tokenCtx.mfaEnrollmentRequired) {
    throw errors.forbidden('Владелец токена не подключил обязательный второй фактор', {
      reason: 'mfa_enrollment_required',
    })
  }

  void ApiTokens.touch(token.id, request.ip ?? null)
  return tokenCtx
}

/** Проверяет, что у токена есть область для этого маршрута. */
export async function enforceTokenScope(request: FastifyRequest): Promise<void> {
  const token = request.ctx.apiToken
  if (!token) return
  const options = request.routeOptions
  const { scope } = requiredScope({
    method: request.method,
    url: options?.url ?? request.url,
    tags: (options?.config as { apiTags?: string[] } | undefined)?.apiTags,
    readOnly: (options?.config as { readOnly?: boolean } | undefined)?.readOnly === true,
  })
  if (scope && scopeSatisfied(token.scopes, scope)) return

  await audit(request.ctx, {
    action: AUDIT_ACTIONS.apiTokenScopeDenied,
    severity: 'warning',
    objectType: 'api_token',
    details: { tokenId: token.id, url: options?.url ?? request.url, scope },
  })
  throw errors.forbidden(
    scope ? `Токену не хватает области доступа «${scope}»` : 'Этот маршрут недоступен токенам API',
    { reason: 'scope_required' },
  )
}
