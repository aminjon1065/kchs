import type { HttpMethod, ProblemDetails } from '@kchs/contracts'
import { normalizeLocale, translate } from '@kchs/i18n'
import { ApiError } from './errors.js'
import type { MethodTable, RequestOptions } from './route-types.js'
import {
  getCsrfToken,
  getOnBehalfOf,
  getShareToken,
  notifySetupRequired,
  notifyUnauthorized,
} from './session.js'
import { requestUrl } from './url.js'

/** Запись пути метода: аргументы вызова после пути и ответ. */
interface PathEntry {
  args: unknown[]
  response: unknown
}

/** Вызов метода: путь — из таблицы, опции и ответ — по её записи. */
type Call<T extends Record<string, PathEntry>> = <P extends keyof T & string>(
  path: P,
  ...options: T[P]['args']
) => Promise<T[P]['response']>

/** Опции после стирания типов: то, с чем работает транспорт. */
export interface RawOptions extends RequestOptions {
  params?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: unknown
}

// ─── Транспорт ───────────────────────────────────────────────────────────────

/** Коды 403 незавершённой настройки входа: оболочка показывает нужный экран. */
const SETUP_CODES = new Set(['password_change_required', 'mfa_enrollment_required'])

function requestHeaders(
  path: string,
  method: HttpMethod,
  hasBody: boolean,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'accept-language': document.documentElement.lang || 'ru',
    ...extra,
  }
  if (hasBody) headers['content-type'] = 'application/json'
  if (method !== 'GET') {
    const token = getCsrfToken()
    if (token) headers['x-csrf-token'] = token
  }
  const shareToken = getShareToken()
  if (shareToken) headers['x-kchs-share-token'] = shareToken
  // Личные запросы идут от себя: иначе выход из режима был бы невозможен
  const onBehalfOf = getOnBehalfOf()
  if (onBehalfOf && !path.startsWith('/me') && !path.startsWith('/auth')) {
    headers['x-kchs-on-behalf-of'] = onBehalfOf
  }
  return headers
}

/**
 * Тело ответа с ошибкой как JSON — или `null`: прокси перед api (Caddy, балансировщик) на
 * 502/504 отдаёт страницу HTML, и разбор не должен падать `SyntaxError` вместо `ApiError`.
 */
function errorPayload(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** Ответ с ошибкой → `ApiError` (проблема RFC 9457 или общая «запрос не выполнен»). */
function problemOf(status: number, payload: unknown): ApiError {
  const problem = (payload ?? {
    type: 'about:blank',
    // Язык интерфейса отражён в <html lang>: клиент API не зависит от оболочки
    title: translate(normalizeLocale(document.documentElement.lang), 'errors.requestFailed'),
    status,
    code: 'internal_error',
  }) as ProblemDetails
  return new ApiError(problem)
}

/**
 * Запрос и ответ без ошибки — или `ApiError` (401 и незавершённая настройка входа — оболочке).
 * Транспорт без типов маршрута — для обёрток каталога `shared/api` (выгрузка файлом); вне
 * каталога его вызов запрещает `scripts/api-calls.mjs`.
 */
export async function send(
  method: HttpMethod,
  path: string,
  options: RawOptions,
): Promise<Response> {
  const response = await fetch(requestUrl(path, options).toString(), {
    method,
    headers: requestHeaders(path, method, options.body !== undefined, options.headers),
    credentials: 'same-origin',
    signal: options.signal,
    keepalive: options.keepalive,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
  if (response.ok) return response
  const text = await response.text()
  const error = problemOf(response.status, errorPayload(text))
  if (response.status === 401 && !options.anonymous) notifyUnauthorized()
  if (response.status === 403 && SETUP_CODES.has(error.problem.code)) notifySetupRequired()
  throw error
}

async function request(method: HttpMethod, path: string, options: RawOptions): Promise<unknown> {
  const response = await send(method, path, options)
  if (response.status === 204) return undefined
  const text = await response.text()
  return text ? (JSON.parse(text) as unknown) : null
}

const call = <T extends Record<string, PathEntry>>(method: HttpMethod): Call<T> =>
  ((path: string, options?: RawOptions) =>
    request(method, path, options ?? {})) as unknown as Call<T>

/**
 * Клиент API по таблице маршрутов (ADR-0188): `http.get('/tasks/:id', { params: { id } })`.
 * Путь — ключ таблицы без метода; параметры пути, строка запроса и тело проверяет
 * компилятор по схемам записи, ответ — выход схемы успешного ответа. Явный параметр
 * типа у вызова запрещён проверкой `pnpm deps:check` (`scripts/api-calls.mjs`).
 */
export const http = {
  get: call<MethodTable<'GET'>>('GET'),
  post: call<MethodTable<'POST'>>('POST'),
  put: call<MethodTable<'PUT'>>('PUT'),
  patch: call<MethodTable<'PATCH'>>('PATCH'),
  delete: call<MethodTable<'DELETE'>>('DELETE'),
}
