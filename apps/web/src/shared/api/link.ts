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

/** Пути GET-маршрутов тайлов таблицы: `…/:z/:x/:y…`. */
type TilePath = Extract<ApiPath<'GET'>, `${string}/:z/:x/:y${string}`>
type TileArgs<P extends TilePath> = NonNullable<MethodTable<'GET'>[P]['args'][0]>
/** Опции шаблона тайлов: параметры пути без `z`, `x`, `y` — их подставляет MapLibre. */
type TileTemplateOptions<P extends TilePath> = Omit<TileArgs<P>, 'params'> & {
  params: Omit<NonNullable<TileArgs<P>['params']>, 'z' | 'x' | 'y'>
}

/**
 * Шаблон тайлов MapLibre по маршруту таблицы: `{z}/{x}/{y}` остаются заполнителями, остальные
 * параметры пути и строка запроса — с ключом кэша `v`/`lv` (ADR-0188) — проверяются по
 * таблице, как у `apiUrl`. Адрес полный: тайлы грузит воркер MapLibre, а не страница.
 */
export function tileUrl<P extends TilePath>(path: P, options: TileTemplateOptions<P>): string {
  const { params, query } = options as {
    params: Record<string, unknown>
    query?: Record<string, unknown>
  }
  const url = requestUrl(path, { params: { ...params, z: '{z}', x: '{x}', y: '{y}' }, query })
  // Заполнители MapLibre — без кодирования
  return url.href.replace(/%7B([zxy])%7D/g, '{$1}')
}
