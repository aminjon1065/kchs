import type { ApiPath, MethodTable } from './route-types.js'
import { requestUrl } from './url.js'

/**
 * Адрес GET-маршрута таблицы для ссылки — файл скачивает браузер:
 * `apiUrl('/admin/audit/export.csv', { query: { action } })`. Путь, параметры и строка
 * запроса проверяются по таблице, как у `http.get`. Это адрес, а не вызов API, поэтому
 * модуль отдельно от клиента: ссылку строит и компонент (ADR-0183), а в чанк оболочки
 * он не попадает.
 */
export function apiUrl<P extends ApiPath<'GET'>>(
  path: P,
  ...options: MethodTable<'GET'>[P]['args']
): string {
  const [raw] = options as unknown as [Parameters<typeof requestUrl>[1]?]
  const url = requestUrl(path, raw ?? {})
  return `${url.pathname}${url.search}`
}
