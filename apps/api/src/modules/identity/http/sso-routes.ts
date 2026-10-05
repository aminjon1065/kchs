import { inArray } from 'drizzle-orm'
import { roles } from '~/kernel/directory/schema.js'
import { config } from '~/shared/config/index.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { addressKey, rateLimit } from '~/shared/http/rate-limit.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { AuthProviders, OIDC_PROVIDER } from '../domain/auth-providers.js'
import { redirectUri, resetDiscoveryCache, SsoService } from '../domain/oidc.js'
import { anyPasskeysExist } from '../domain/passkeys.js'
import { setSessionCookie } from './session-cookie.js'

/**
 * Единый вход через корпоративный IdP (ADR-0098) и список способов входа
 * для экрана входа. Секрет клиента наружу не возвращается.
 */
export function registerSsoRoutes(route: RouteRegistrar): void {
  const env = config()

  route({
    route: 'GET /auth/methods',
    auth: 'public',
    tags: ['auth'],
    summary: 'Доступные способы входа',
    handler: async () => {
      const [sso, passkeys] = await Promise.all([SsoService.available(), anyPasskeysExist()])
      return { password: true, sso, passkeys }
    },
  })

  route({
    route: 'POST /auth/sso/start',
    auth: 'public',
    tags: ['auth'],
    summary: 'Начать вход через корпоративный IdP',
    rateLimit: {
      ...rateLimit(20, '1 minute'),
      keyGenerator: (request) => addressKey('sso-start', request, ''),
    },
    handler: async (request) =>
      SsoService.start({
        ip: request.ip ?? null,
        userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
        requestId: request.id,
      }),
  })

  route({
    route: 'GET /auth/sso/callback',
    auth: 'public',
    tags: ['auth'],
    summary: 'Возврат от корпоративного IdP',
    rateLimit: {
      ...rateLimit(30, '1 minute'),
      keyGenerator: (request) => addressKey('sso-callback', request, ''),
    },
    handler: async (request, reply) => {
      const base = env.KCHS_BASE_URL.replace(/\/+$/, '')
      if (request.query.error) {
        // Отказ IdP: человек возвращается на экран входа с понятной пометкой
        return reply.redirect(`${base}/?sso=denied`)
      }
      const result = await SsoService.callback(request.query as Record<string, string>, {
        ip: request.ip ?? null,
        userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
        requestId: request.id,
      })
      setSessionCookie(reply, result.sessionToken, result.expiresAt)
      return reply.redirect(`${base}/`)
    },
  })

  // ─── Администрирование ────────────────────────────────────────────────────
  route({
    route: 'GET /admin/sso',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Настройка единого входа',
    handler: async () => {
      const { enabled, settings, clientSecret, updatedAt } = await AuthProviders.sso()
      return {
        ...settings,
        enabled,
        hasClientSecret: clientSecret !== null,
        updatedAt,
        redirectUri: redirectUri(),
      }
    },
  })

  route({
    route: 'PUT /admin/sso',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Изменить настройку единого входа',
    handler: async (request) => {
      const input = request.body
      const keys = [
        ...new Set([
          ...input.defaultRoleKeys,
          ...input.groupMappings.map((mapping) => mapping.roleKey),
        ]),
      ].filter(Boolean)
      if (keys.length > 0) {
        const found = await db()
          .select({ key: roles.key })
          .from(roles)
          .where(inArray(roles.key, keys))
        const missing = keys.filter((key) => !found.some((row) => row.key === key))
        if (missing.length > 0) {
          throw errors.validation('Неизвестные роли', [
            { path: 'groupMappings', message: missing.join(', '), code: 'unknown_role' },
          ])
        }
      }
      if (input.enabled && (!input.issuer || !input.clientId)) {
        throw errors.validation('Для включения нужны адрес издателя и идентификатор клиента', [
          { path: 'issuer', message: 'Заполните адрес издателя и идентификатор клиента' },
        ])
      }
      await db().transaction((tx) => AuthProviders.saveSso(tx, request.ctx, input))
      AuthProviders.invalidate(OIDC_PROVIDER)
      resetDiscoveryCache()

      const { enabled, settings, clientSecret, updatedAt } = await AuthProviders.sso()
      return {
        ...settings,
        enabled,
        hasClientSecret: clientSecret !== null,
        updatedAt,
        redirectUri: redirectUri(),
      }
    },
  })

  route({
    route: 'POST /admin/sso/test',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Проверить соединение с IdP',
    rateLimit: rateLimit(10, '1 minute'),
    handler: async () => SsoService.test(),
  })
}
