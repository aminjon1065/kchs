import { API_SCOPES } from '@kchs/contracts'
import { rateLimit } from '~/shared/http/rate-limit.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { ApiTokens } from '../domain/api-tokens.js'

/**
 * Токены публичного API (14-automation-integrations.md §3, ADR-0097).
 * Личные токены — в профиле, все токены установки — в администрировании.
 * Сами маршруты закрыты для токенов: ключ не выпускает другой ключ.
 */
export function registerApiTokenRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /me/api-tokens',
    auth: 'session',
    tags: ['me'],
    summary: 'Мои токены API',
    handler: async (request) => ({
      items: await ApiTokens.list({
        userId: request.ctx.userId,
        includeRevoked: request.query.includeRevoked,
      }),
    }),
  })

  route({
    route: 'POST /me/api-tokens',
    auth: { capability: 'api_tokens.create' },
    tags: ['me'],
    summary: 'Выпустить токен API: значение показывается один раз',
    rateLimit: rateLimit(10, '1 minute'),
    handler: async (request) => ApiTokens.issue(request.ctx, request.body),
  })

  route({
    route: 'DELETE /me/api-tokens/:id',
    auth: { owned: 'ApiTokens.revoke — только свой токен' },
    tags: ['me'],
    summary: 'Отозвать токен API',
    handler: async (request) => {
      await ApiTokens.revoke(request.ctx, request.params.id)
      return { ok: true }
    },
  })

  route({
    route: 'GET /admin/api-tokens',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Все токены API установки',
    handler: async (request) => ({
      items: await ApiTokens.list({
        ...(request.query.userId ? { userId: request.query.userId } : {}),
        includeRevoked: request.query.includeRevoked,
      }),
    }),
  })

  route({
    route: 'DELETE /admin/api-tokens/:id',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Отозвать чужой токен API',
    handler: async (request) => {
      await ApiTokens.revoke(request.ctx, request.params.id)
      return { ok: true }
    },
  })

  route({
    route: 'GET /admin/api-tokens/scopes',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Справочник областей доступа токена',
    handler: async () => ({ items: [...API_SCOPES] }),
  })
}
