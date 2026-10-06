import type {
  HttpMethod,
  RouteBody,
  RouteContract,
  RouteParams,
  RoutePath,
  RouteQuery,
  RouteResponse,
} from '@kchs/contracts'
import type { ApiRouteKey, Routes } from '@kchs/process/routes'
import type { z } from 'zod'

/**
 * Типы клиента API по таблице маршрутов (ADR-0188). Только типы: `import type { Routes }`
 * схемы API в бандл не тянет. Отдельно от транспорта (`client.ts`): тип ответа или тела
 * нужен и компоненту, а вызывать API компонент не должен (ADR-0183).
 */

/** Ключи таблицы с методом `M`. */
type KeyOf<M extends HttpMethod> = Extract<ApiRouteKey, `${M} ${string}`>

/** Пути таблицы для метода: `ApiPath<'GET'>` — `'/tasks/:id' | …`, без `/api/v1`. */
export type ApiPath<M extends HttpMethod> = RoutePath<KeyOf<M>>

/**
 * Ответы маршрутов, у которых в таблице нет схемы ответа (ADR-0188, «Ответ без схемы»):
 * тип контракта без проверки сервером. Запись удаляется, когда схема ответа появится в
 * таблице: запись для маршрута со схемой не скомпилируется (`Undescribed`).
 */
type UndescribedResponses = Undescribed<{
  /** Стиль MapLibre (спецификация v8) — как отдал сервер. */
  'GET /gis/basemaps/:id/style.json': Record<string, unknown>
}>

type Undescribed<
  T extends {
    [K in keyof T]: K extends ApiRouteKey
      ? unknown extends RouteResponse<Routes[K]>
        ? unknown
        : never
      : never
  },
> = T

/** Ответ маршрута по ключу: `ApiResponse<'GET /tasks/:id'>` — выход схемы успешного ответа. */
export type ApiResponse<K extends ApiRouteKey> = K extends keyof UndescribedResponses
  ? UndescribedResponses[K]
  : RouteResponse<Routes[K]>

/** Тело запроса по ключу: вход схемы тела. */
export type ApiBody<K extends ApiRouteKey> = RouteBody<Routes[K]>

/** Строка запроса по ключу: вход схемы строки запроса. */
export type ApiQuery<K extends ApiRouteKey> = RouteQuery<Routes[K]>

/** Обязательно поле или нет: необязательно, если без него значение подходит. */
type Field<Name extends string, T, Optional extends boolean> = Optional extends true
  ? { [N in Name]?: T }
  : { [N in Name]: T }

/** Параметры пути, строка запроса и тело — по записи таблицы. */
type RouteFields<C extends RouteContract, K extends string> = (C extends { params: z.ZodType }
  ? Field<'params', RouteParams<C, K>, false>
  : { params?: undefined }) &
  (C extends { query: z.ZodType }
    ? Field<'query', RouteQuery<C>, Partial<RouteQuery<C>> extends RouteQuery<C> ? true : false>
    : { query?: undefined }) &
  (C extends { body: z.ZodType }
    ? Field<'body', RouteBody<C>, undefined extends RouteBody<C> ? true : false>
    : { body?: undefined })

/** Опции транспорта, общие для всех маршрутов. */
export interface RequestOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
  /** Не перенаправлять на вход при 401 (используется самим экраном входа). */
  anonymous?: boolean
  /** Запрос переживает закрытие страницы (сохранение при уходе). */
  keepalive?: boolean
}

/** Опции вызова маршрута `K`. */
type ApiOptions<K extends ApiRouteKey> = RequestOptions & RouteFields<Routes[K], K>

/** Опции — необязательный аргумент, если у маршрута нет обязательных полей. */
type OptionsArg<K extends ApiRouteKey> =
  Partial<ApiOptions<K>> extends ApiOptions<K>
    ? [options?: ApiOptions<K>]
    : [options: ApiOptions<K>]

/**
 * Аргументы вызова после пути и ответ — для каждого пути метода, по записи таблицы.
 * Путь — ключ с переназначением (`as`): обращение по параметру типа вызова компилятор
 * не раскрывает подстановкой ограничения, иначе он перемножал бы пути метода и ключи
 * таблицы («union type that is too complex to represent»).
 */
export type MethodTable<M extends HttpMethod> = {
  [K in KeyOf<M> as RoutePath<K>]: { args: OptionsArg<K>; response: ApiResponse<K> }
}
