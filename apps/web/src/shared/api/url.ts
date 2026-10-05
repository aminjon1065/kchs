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
      throw new Error(`${path}: нет параметра пути ${name}`)
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
