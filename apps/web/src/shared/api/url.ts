import type { ApiPath, MethodTable } from './route-types.js'

/** База HTTP API: ключи таблицы маршрутов — без неё (ADR-0188). */
const BASE = '/api/v1'

/**
 * Путь таблицы → путь запроса: `:имя` заменяется закодированным значением параметра.
 * Имя параметра кончается на `.` или `-`, как у маршрутизатора Fastify (`:y.pbf`).
 */
function resolvePath(path: string, params: Record<string, unknown> | undefined): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params?.[name]
    if (value === undefined || value === null || value === '') {
      throw new Error(`Параметр пути «${name}» не задан: ${path}`)
    }
    return encodeURIComponent(String(value))
  })
}

/** Адрес запроса: путь с параметрами и строка запроса без пустых значений. */
export function requestUrl(
  path: string,
  options: { params?: Record<string, unknown>; query?: Record<string, unknown> },
): URL {
  const url = new URL(`${BASE}${resolvePath(path, options.params)}`, window.location.origin)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

/**
 * Адрес GET-маршрута таблицы для ссылки — файл скачивает браузер:
 * `apiUrl('/admin/audit/export.csv', { query: { action } })`. Путь, параметры и строка
 * запроса проверяются по таблице, как у `http.get`. Это адрес, а не вызов API, поэтому
 * модуль отдельно от клиента: ссылку строит и компонент (ADR-0183).
 */
export function apiUrl<P extends ApiPath<'GET'>>(
  path: P,
  ...options: MethodTable<'GET'>[P]['args']
): string {
  const [raw] = options as unknown as [Parameters<typeof requestUrl>[1]?]
  const url = requestUrl(path, raw ?? {})
  return `${url.pathname}${url.search}`
}
