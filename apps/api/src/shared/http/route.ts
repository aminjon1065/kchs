import {
  type HttpMethod,
  type ObjectType,
  type RouteContract,
  splitRouteKey,
} from '@kchs/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import type { z } from 'zod'
import type { UserCtx } from '../context.js'
import { type ApiRouteKey, type RouteTable, routeTable } from './route-table.js'

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

/** Часть запроса после разбора схемой маршрута из таблицы; без схемы — `unknown`. */
type Parsed<C, Part extends keyof RouteContract> =
  C extends Record<Part, infer Schema>
    ? Schema extends z.ZodType
      ? z.output<Schema>
      : unknown
    : unknown

/**
 * Регистрация маршрута (ADR-0188): метод, путь и схемы — запись таблицы маршрутов
 * контрактов по ключу `route`; здесь — политика доступа, обработчик и описание.
 */
export interface RouteDefinition<K extends ApiRouteKey> {
  /** Ключ таблицы маршрутов: метод и путь в синтаксисе Fastify — `GET /tasks/:id`. */
  route: K
  auth: RouteAuth
  summary?: string
  description?: string
  tags?: string[]
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
      Params: Parsed<RouteTable[K], 'params'>
      Querystring: Parsed<RouteTable[K], 'query'>
      Body: Parsed<RouteTable[K], 'body'>
    }> & { ctx: UserCtx },
    reply: FastifyReply,
  ) => Promise<unknown>
}

export type RouteRegistrar = <K extends ApiRouteKey>(definition: RouteDefinition<K>) => void

/** Схемы маршрута в том виде, в каком их принимает Fastify. */
export interface RouteSchema {
  params?: z.ZodType
  querystring?: z.ZodType
  body?: z.ZodType
  response?: Readonly<Record<number, z.ZodType>>
}

/** Маршрут в реестре процесса: по нему тесты проверяют политики всех маршрутов (ADR-0186). */
export interface RegisteredRoute {
  method: HttpMethod
  url: string
  auth: RouteAuth
  schema?: RouteSchema
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
export function assertRouteAuth(definition: {
  method: HttpMethod
  url: string
  auth: RouteAuth
}): void {
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

/** Запись таблицы маршрутов по ключу; маршрута без записи нет (ADR-0188). */
function contractOf(key: string): RouteContract {
  const table: Readonly<Record<string, RouteContract>> = routeTable
  const contract = Object.hasOwn(table, key) ? table[key] : undefined
  if (!contract) {
    throw new Error(
      `Маршрут ${key} не описан в таблице маршрутов контрактов: добавьте запись в ` +
        'packages/contracts/src/routes (ADR-0188)',
    )
  }
  return contract
}

function schemaOf(contract: RouteContract): RouteSchema | undefined {
  const schema: RouteSchema = {
    ...(contract.params ? { params: contract.params } : {}),
    ...(contract.query ? { querystring: contract.query } : {}),
    ...(contract.body ? { body: contract.body } : {}),
    ...(contract.response ? { response: contract.response } : {}),
  }
  return Object.keys(schema).length > 0 ? schema : undefined
}

/**
 * Каждая запись таблицы маршрутов зарегистрирована (ADR-0188): проверка после
 * регистрации модулей — контракт без обработчика не доживёт до запуска, как и
 * обработчик без контракта (`contractOf`).
 */
export function assertRouteTableRegistered(): void {
  const keys = new Set(registered.map((r) => `${r.method} ${r.url}`))
  const missing = Object.keys(routeTable).filter((key) => !keys.has(key))
  if (missing.length > 0) {
    throw new Error(
      `Маршруты таблицы контрактов не зарегистрированы: ${missing.join(', ')} (ADR-0188)`,
    )
  }
}

/** Собирает регистратор маршрутов поверх Fastify с zod-провайдером. */
export function routeRegistrar(app: FastifyInstance): RouteRegistrar {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  return (definition) => {
    const schema = schemaOf(contractOf(definition.route))
    const { method, url } = splitRouteKey(definition.route)
    assertRouteAuth({ method, url, auth: definition.auth })
    if (!registered.some((r) => r.method === method && r.url === url)) {
      registered.push({ method, url, auth: definition.auth, ...(schema ? { schema } : {}) })
    }

    typed.route({
      method,
      url,
      schema: {
        summary: definition.summary,
        description: definition.description,
        tags: definition.tags,
        ...schema,
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
