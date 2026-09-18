import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import type { z } from 'zod'
import type { UserCtx } from '../context.js'

/**
 * Политика доступа маршрута. Обязательна: регистрация без `auth` падает на старте
 * (17-security.md §3, 01-project-structure.md).
 *
 *  - `public`   — без аутентификации (вход, здоровье, гостевая ссылка)
 *  - `session`  — нужна действующая сессия, объект не проверяется
 *  - `{action}` — нужно право на объект: `authorize(ctx, action, objectRef)`
 */
export type RouteAuth =
  | 'public'
  | 'session'
  | {
      /** Действие модуля, например `file.download` или `space.manage`. */
      action: string
      /** Имя параметра пути с идентификатором объекта (по умолчанию `id`). */
      objectParam?: string
      /** Способность, требуемая дополнительно к уровню. */
      capability?: string
    }
  | {
      /** Только глобальная способность, без объекта. */
      capability: string
    }

export interface RouteDefinition<
  Params extends z.ZodTypeAny = z.ZodTypeAny,
  Query extends z.ZodTypeAny = z.ZodTypeAny,
  Body extends z.ZodTypeAny = z.ZodTypeAny,
  Reply extends z.ZodTypeAny = z.ZodTypeAny,
> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  auth: RouteAuth
  summary?: string
  description?: string
  tags?: string[]
  schema?: {
    params?: Params
    querystring?: Query
    body?: Body
    response?: Record<number, Reply>
  }
  config?: RouteShorthandOptions['config']
  rateLimit?: {
    max: number
    timeWindow: string
    /** Свой ключ счётчика вместо «пользователь или адрес» (например, адрес + ссылка). */
    keyGenerator?: (request: FastifyRequest) => string
  }
  /** Маршрут доступен, пока пользователь не сменил временный пароль. */
  allowPendingPasswordChange?: boolean
  /** Маршрут доступен, пока пользователь не подключил обязательный по политике второй фактор. */
  allowPendingMfaEnrollment?: boolean
  handler: (
    request: FastifyRequest<{
      Params: z.infer<Params>
      Querystring: z.infer<Query>
      Body: z.infer<Body>
    }> & { ctx: UserCtx },
    reply: FastifyReply,
  ) => Promise<unknown>
}

export type RouteRegistrar = <
  Params extends z.ZodTypeAny = z.ZodTypeAny,
  Query extends z.ZodTypeAny = z.ZodTypeAny,
  Body extends z.ZodTypeAny = z.ZodTypeAny,
  Reply extends z.ZodTypeAny = z.ZodTypeAny,
>(
  definition: RouteDefinition<Params, Query, Body, Reply>,
) => void

/** Собирает регистратор маршрутов поверх Fastify с zod-провайдером. */
export function routeRegistrar(app: FastifyInstance): RouteRegistrar {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  return (definition) => {
    if (!definition.auth) {
      throw new Error(
        `Маршрут ${definition.method} ${definition.url} зарегистрирован без политики auth`,
      )
    }

    typed.route({
      method: definition.method,
      url: definition.url,
      schema: {
        summary: definition.summary,
        description: definition.description,
        tags: definition.tags,
        ...(definition.schema?.params ? { params: definition.schema.params } : {}),
        ...(definition.schema?.querystring ? { querystring: definition.schema.querystring } : {}),
        ...(definition.schema?.body ? { body: definition.schema.body } : {}),
        ...(definition.schema?.response ? { response: definition.schema.response } : {}),
      },
      config: {
        ...definition.config,
        auth: definition.auth,
        ...(definition.rateLimit ? { rateLimit: definition.rateLimit } : {}),
        ...(definition.allowPendingPasswordChange ? { allowPendingPasswordChange: true } : {}),
        ...(definition.allowPendingMfaEnrollment ? { allowPendingMfaEnrollment: true } : {}),
      },
      handler: definition.handler as never,
    })
  }
}
