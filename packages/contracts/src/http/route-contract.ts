import type { z } from 'zod'

/**
 * Таблица маршрутов HTTP API (ADR-0188): схемы маршрута — параметры пути, строка
 * запроса, тело и ответы — описаны здесь, в контрактах, один раз. api регистрирует
 * маршрут по ключу таблицы и берёт схемы отсюда, клиент по тому же ключу знает
 * типы пути, параметров, тела и ответа.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** Ключ маршрута: метод и путь в синтаксисе Fastify — `GET /tasks/:id`. */
export type RouteKey = `${HttpMethod} /${string}`

export interface RouteContract {
  /** Параметры пути (`:id`). */
  params?: z.ZodType
  /** Строка запроса. */
  query?: z.ZodType
  /** Тело запроса. */
  body?: z.ZodType
  /**
   * Ответы по кодам, как в Fastify. Без схемы — ответ не описан: файл, поток или
   * ответ, форму которого маршрут пока не объявил.
   */
  response?: Readonly<Record<number, z.ZodType>>
}

export type RouteTable = Readonly<Record<RouteKey, RouteContract>>

const KEY_PATTERN = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/

/**
 * Таблица маршрутов модуля. Ключи проверяются при загрузке: опечатка в методе или
 * пути не доживёт до регистрации.
 */
export function defineRoutes<const T extends Record<RouteKey, RouteContract>>(routes: T): T {
  for (const key of Object.keys(routes)) {
    if (!KEY_PATTERN.test(key)) {
      throw new Error(`Ключ маршрута «${key}»: ожидается «МЕТОД /путь»`)
    }
  }
  return routes
}

/** Метод и путь ключа маршрута. */
export function splitRouteKey(key: string): { method: HttpMethod; url: string } {
  const match = KEY_PATTERN.exec(key)
  if (!match) throw new Error(`Ключ маршрута «${key}»: ожидается «МЕТОД /путь»`)
  return { method: match[1] as HttpMethod, url: match[2] as string }
}

/** Объединение таблиц модулей: ключ, описанный дважды, — ошибка. */
export function mergeRouteTables<const T extends readonly RouteTable[]>(
  ...tables: T
): UnionToIntersection<T[number]> {
  const merged: Record<string, RouteContract> = {}
  for (const table of tables) {
    for (const [key, contract] of Object.entries(table)) {
      if (key in merged) throw new Error(`Маршрут ${key} описан в двух таблицах`)
      merged[key] = contract
    }
  }
  return merged as UnionToIntersection<T[number]>
}

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (
  value: infer I,
) => void
  ? I
  : never

// ─── Вывод типов по ключу (для клиента) ──────────────────────────────────────

/** Путь ключа: `GET /tasks/:id` → `/tasks/:id`. */
export type RoutePath<K extends string> = K extends `${HttpMethod} ${infer P}` ? P : never

/** Метод ключа. */
export type RouteMethod<K extends string> = K extends `${infer M extends HttpMethod} ${string}`
  ? M
  : never

/** Имена параметров пути: `/tasks/:id/items/:itemId` → `'id' | 'itemId'`. */
export type PathParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never

type SuccessCode = 200 | 201 | 202 | 204

type Input<S> = S extends z.ZodType ? z.input<S> : undefined

/**
 * Параметры пути, которые передаёт клиент: по схеме маршрута, а без неё — по
 * именам сегментов `:имя` пути.
 */
export type RouteParams<C extends RouteContract, K extends string = string> =
  C['params'] extends z.ZodType
    ? z.input<C['params']>
    : [PathParamNames<RoutePath<K>>] extends [never]
      ? undefined
      : { [Name in PathParamNames<RoutePath<K>>]: string }

/** Строка запроса, которую передаёт клиент. */
export type RouteQuery<C extends RouteContract> = Input<C['query']>

/** Тело запроса, которое передаёт клиент. */
export type RouteBody<C extends RouteContract> = Input<C['body']>

/** Успешный ответ (2xx) после разбора; маршрут без схемы ответа — `unknown`. */
export type RouteResponse<C extends RouteContract> =
  C['response'] extends Readonly<Record<number, z.ZodType>>
    ? Extract<keyof C['response'], SuccessCode> extends infer Code
      ? [Code] extends [never]
        ? unknown
        : Code extends keyof C['response']
          ? C['response'][Code] extends z.ZodType
            ? z.output<C['response'][Code]>
            : unknown
          : unknown
      : unknown
    : unknown
