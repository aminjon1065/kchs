import { mergeRouteTables } from '@kchs/contracts'
import { type ApiRoutes, apiRoutes } from '@kchs/contracts/routes'
import { documentProcessRoutes, processRoutes } from '@kchs/process'

/** Полная таблица маршрутов HTTP API: контракты и движок процессов. */
export type RouteTable = ApiRoutes & typeof processRoutes & typeof documentProcessRoutes

/** Ключ маршрута таблицы: `GET /tasks/:id`. */
export type ApiRouteKey = keyof RouteTable & string

/**
 * Полная таблица маршрутов HTTP API (ADR-0188): ядро и модули — из контрактов,
 * движок процессов — из `@kchs/process` (ADR-0079). Регистратор маршрутов берёт
 * схемы отсюда, а маршрут вне таблицы не регистрирует.
 */
export const routeTable: RouteTable = mergeRouteTables(
  apiRoutes,
  processRoutes,
  documentProcessRoutes,
)
