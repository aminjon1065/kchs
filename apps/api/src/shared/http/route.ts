import type { ObjectType } from '@kchs/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import type { z } from 'zod'
import type { UserCtx } from '../context.js'

/**
 * Политика доступа маршрута. Обязательна: регистрация без `auth` падает на старте
 * (17-security.md §3, 01-project-structure.md).
 *
 *  - `public`      — без аутентификации (вход, здоровье, гостевая ссылка)
 *  - `session`     — нужна действующая сессия; в пути нет параметров
 *  - `{action}`    — нужно право на объект: `authorize(ctx, action, objectRef)`
 *  - `{delegated}` — сессия, объект из пути проверяет названный сервис (ADR-0186)
 *  - `{owned}`     — сессия, в пути свой ресурс пользователя (ADR-0186)
 *  - `{open}`      — сессия, в пути общий справочник, видимый всем вошедшим (ADR-0186)
 *  - `{engineJob}` — обратный вызов движка токеном своего задания (ADR-0176)
 *
 * Маршрут `session` с параметром пути не регистрируется: кто проверяет доступ к
 * тому, что в пути, должно быть сказано явно (ADR-0186).
 */
export type RouteAuth =
  | 'public'
  | 'session'
  | {
      /**
       * Сессия, а то, что в пути, проверяет сервис обработчика: здесь — какой
       * (`TaskService.get`, `authorize(view)`). Объявление нужно, чтобы проверку
       * нельзя было забыть молча. Что в пути — `objectType` (тип объекта реестра
       * в параметре `objectParam`, по умолчанию `id`; `any` — любой тип) или
       * `resource` (вложенный ресурс объекта: сообщение, запуск, ход маршрута).
       * По ним тест «посторонний не видит» выбирает, чем подставить параметр.
       */
      delegated: string
      objectType?: ObjectType | readonly ObjectType[] | 'any'
      resource?: string
      objectParam?: string
    }
  | {
      /**
       * Сессия; в пути — свой ресурс пользователя вне реестра объектов (сессия,
       * ключ входа, токен, элемент «Входящих», загрузка): сервис ищет его только
       * среди ресурсов вошедшего. Строка — кто это делает.
       */
      owned: string
    }
  | {
      /**
       * Сессия; в пути — общий справочник, который видит каждый вошедший
       * (территория, карточка сотрудника, глифы карты). Строка — почему объектной
       * проверки нет.
       */
      open: string
    }
  | {
      /**
       * Обратный вызов движка по заданию: заголовок `x-kchs-job-token` с токеном,
       * который api выдал заданию при передаче в очередь. Общий сервисный токен
       * здесь не принимается. Маршрут называет, что открывает токен: `jobParam` —
       * параметр пути с id записи задания, `scope` — ресурс задания по
       * параметрам пути (`file:<id>`), тот же, что модуль указал при постановке.
       */
      engineJob: EngineJobScope
    }
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

export type EngineJobScope =
  | { jobParam: string }
  | { scope: (params: Record<string, string>) => string }

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
  /**
   * POST, который не меняет данных (выполнить запрос, посчитать показатель):
   * доступен странице печати со служебным токеном (ADR-0078).
   */
  readOnly?: boolean
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

/** Маршрут в реестре процесса: по нему тесты проверяют политики всех маршрутов (ADR-0186). */
export interface RegisteredRoute {
  method: RouteDefinition['method']
  url: string
  auth: RouteAuth
  schema?: RouteDefinition['schema']
}

const registered: RegisteredRoute[] = []

/** Все маршруты, зарегистрированные в процессе (повтор сборки приложения — без дублей). */
export function registeredRoutes(): readonly RegisteredRoute[] {
  return registered
}

const PATH_PARAM = /:[A-Za-z_]\w*/

/**
 * Проверка объявления до регистрации (ADR-0186): маршрут `session` с параметром
 * пути должен сказать, кто проверяет доступ к тому, что в пути.
 */
export function assertRouteAuth(
  definition: Pick<RouteDefinition, 'method' | 'url' | 'auth'>,
): void {
  const { auth, method, url } = definition
  if (!auth) throw new Error(`Маршрут ${method} ${url} зарегистрирован без политики auth`)
  if (auth === 'session' && PATH_PARAM.test(url)) {
    throw new Error(
      `Маршрут ${method} ${url}: параметр пути при auth: 'session' — объявите, кто ` +
        'проверяет доступ: { delegated, objectType | resource }, { owned } или { open } (ADR-0186)',
    )
  }
  if (typeof auth === 'object' && 'delegated' in auth) {
    if (!auth.delegated.trim()) throw new Error(`Маршрут ${method} ${url}: пустое delegated`)
    if (Boolean(auth.objectType) === Boolean(auth.resource)) {
      throw new Error(
        `Маршрут ${method} ${url}: у delegated нужен ровно один из objectType и resource`,
      )
    }
    const param = auth.objectParam ?? 'id'
    if (auth.objectType && !url.includes(`:${param}`)) {
      throw new Error(`Маршрут ${method} ${url}: нет параметра пути «${param}» для objectType`)
    }
  }
  if (typeof auth === 'object' && 'owned' in auth && !auth.owned.trim()) {
    throw new Error(`Маршрут ${method} ${url}: пустое owned`)
  }
  if (typeof auth === 'object' && 'open' in auth && !auth.open.trim()) {
    throw new Error(`Маршрут ${method} ${url}: пустое open — нужна причина`)
  }
}

/** Собирает регистратор маршрутов поверх Fastify с zod-провайдером. */
export function routeRegistrar(app: FastifyInstance): RouteRegistrar {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  return (definition) => {
    assertRouteAuth(definition)
    if (!registered.some((r) => r.method === definition.method && r.url === definition.url)) {
      registered.push({
        method: definition.method,
        url: definition.url,
        auth: definition.auth,
        ...(definition.schema ? { schema: definition.schema } : {}),
      })
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
        // Теги нужны не только OpenAPI: по ним определяется область доступа
        // токена публичного API (ADR-0097)
        ...(definition.tags ? { apiTags: definition.tags } : {}),
        ...(definition.rateLimit ? { rateLimit: definition.rateLimit } : {}),
        ...(definition.allowPendingPasswordChange ? { allowPendingPasswordChange: true } : {}),
        ...(definition.allowPendingMfaEnrollment ? { allowPendingMfaEnrollment: true } : {}),
        ...(definition.readOnly ? { readOnly: true } : {}),
      },
      handler: definition.handler as never,
    })
  }
}
