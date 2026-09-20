import { API_SCOPES, ApiToken, ApiTokenCreated, ApiTokenCreateInput } from '@kchs/contracts'
import { z } from 'zod'
import { rateLimit } from '~/shared/http/rate-limit.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { ApiTokens } from '../domain/api-tokens.js'

const TokenList = z.object({ items: z.array(ApiToken) })

/**
 * Токены публичного API (14-automation-integrations.md §3, ADR-0097).
 * Личные токены — в профиле, все токены установки — в администрировании.
 * Сами маршруты закрыты для токенов: ключ не выпускает другой ключ.
 */
export function registerApiTokenRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/me/api-tokens',
    auth: 'session',
    tags: ['me'],
    summary: 'Мои токены API',
    schema: {
      querystring: z.object({ includeRevoked: z.coerce.boolean().default(false) }),
      response: { 200: TokenList },
    },
    handler: async (request) => ({
      items: await ApiTokens.list({
        userId: request.ctx.userId,
        includeRevoked: request.query.includeRevoked,
      }),
    }),
  })

  route({
    method: 'POST',
    url: '/me/api-tokens',
    auth: { capability: 'api_tokens.create' },
    tags: ['me'],
    summary: 'Выпустить токен API: значение показывается один раз',
    schema: { body: ApiTokenCreateInput, response: { 200: ApiTokenCreated } },
    rateLimit: rateLimit(10, '1 minute'),
    handler: async (request) => ApiTokens.issue(request.ctx, request.body),
  })

  route({
    method: 'DELETE',
    url: '/me/api-tokens/:id',
    auth: 'session',
    tags: ['me'],
    summary: 'Отозвать токен API',
    schema: {
      params: z.object({ id: z.uuid() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await ApiTokens.revoke(request.ctx, request.params.id)
      return { ok: true }
    },
  })

  route({
    method: 'GET',
    url: '/admin/api-tokens',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Все токены API установки',
    schema: {
      querystring: z.object({
        userId: z.uuid().optional(),
        includeRevoked: z.coerce.boolean().default(true),
      }),
      response: { 200: TokenList },
    },
    handler: async (request) => ({
      items: await ApiTokens.list({
        ...(request.query.userId ? { userId: request.query.userId } : {}),
        includeRevoked: request.query.includeRevoked,
      }),
    }),
  })

  route({
    method: 'DELETE',
    url: '/admin/api-tokens/:id',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Отозвать чужой токен API',
    schema: {
      params: z.object({ id: z.uuid() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await ApiTokens.revoke(request.ctx, request.params.id)
      return { ok: true }
    },
  })

  route({
    method: 'GET',
    url: '/admin/api-tokens/scopes',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Справочник областей доступа токена',
    schema: { response: { 200: z.object({ items: z.array(z.string()) }) } },
    handler: async () => ({ items: [...API_SCOPES] }),
  })
}
