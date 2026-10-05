import type { HttpMethod, ProblemDetails } from '@kchs/contracts'
import { normalizeLocale, translate } from '@kchs/i18n'
import type { ApiPath, MethodTable, RequestOptions } from './route-types.js'
import { requestUrl } from './url.js'

export class ApiError extends Error {
  readonly status: number
  readonly problem: ProblemDetails

  constructor(problem: ProblemDetails) {
    super(problem.detail ?? problem.title)
    this.name = 'ApiError'
    this.status = problem.status
    this.problem = problem
  }

  get code(): string {
    return this.problem.code
  }

  fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const item of this.problem.errors ?? []) result[item.path] = item.message
    return result
  }
}

/** CSRF-токен выдаётся при входе и требуется для изменяющих запросов. */
let csrfToken: string | null = null

export function setCsrfToken(token: string | null): void {
  csrfToken = token
  try {
    if (token) sessionStorage.setItem('kchs.csrf', token)
    else sessionStorage.removeItem('kchs.csrf')
  } catch {
    // приватный режим
  }
}

export function getCsrfToken(): string | null {
  if (csrfToken) return csrfToken
  try {
    csrfToken = sessionStorage.getItem('kchs.csrf')
  } catch {
    csrfToken = null
  }
  return csrfToken
}

/** Токен гостевой ссылки: доступ к одному объекту без входа. */
let shareToken: string | null = null

export function setShareToken(token: string | null): void {
  shareToken = token
}

/** Режим «от имени»: действия записываются с `onBehalfOf` (замещение). */
let onBehalfOf: string | null = readOnBehalfOf()

function readOnBehalfOf(): string | null {
  try {
    return sessionStorage.getItem('kchs.onBehalfOf')
  } catch {
    return null
  }
}

export function setOnBehalfOf(userId: string | null): void {
  onBehalfOf = userId
  try {
    if (userId) sessionStorage.setItem('kchs.onBehalfOf', userId)
    else sessionStorage.removeItem('kchs.onBehalfOf')
  } catch {
    // приватный режим
  }
}

export function getOnBehalfOf(): string | null {
  return onBehalfOf
}

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
interface RawOptions extends RequestOptions {
  params?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: unknown
}

// ─── Транспорт ───────────────────────────────────────────────────────────────

type UnauthorizedHandler = () => void
let onUnauthorized: UnauthorizedHandler | null = null

/**
 * Незавершённая настройка входа (временный пароль, обязательный второй фактор):
 * сервер отвечает 403 с кодом — оболочка перечитывает профиль и показывает
 * нужный экран. Так политика, включённая во время работы, применяется сразу.
 */
type SetupRequiredHandler = () => void
let onSetupRequired: SetupRequiredHandler | null = null
const SETUP_CODES = new Set(['password_change_required', 'mfa_enrollment_required'])

export function setSetupRequiredHandler(handler: SetupRequiredHandler | null): void {
  onSetupRequired = handler
}

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler
}

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
  if (shareToken) headers['x-kchs-share-token'] = shareToken
  // Личные запросы идут от себя: иначе выход из режима был бы невозможен
  if (onBehalfOf && !path.startsWith('/me') && !path.startsWith('/auth')) {
    headers['x-kchs-on-behalf-of'] = onBehalfOf
  }
  return headers
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

/** Запрос и ответ без ошибки — или `ApiError` (401 и незавершённая настройка входа — оболочке). */
async function send(method: HttpMethod, path: string, options: RawOptions): Promise<Response> {
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
  const error = problemOf(response.status, text ? (JSON.parse(text) as unknown) : null)
  if (response.status === 401 && !options.anonymous) onUnauthorized?.()
  if (response.status === 403 && SETUP_CODES.has(error.problem.code)) onSetupRequired?.()
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

/** Сохранить файл из памяти: браузер скачивает его под этим именем. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Имя файла из `Content-Disposition`: `filename*` (UTF-8) важнее `filename`. */
function dispositionName(header: string | null): string | null {
  if (!header) return null
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1]
  if (encoded) return decodeURIComponent(encoded)
  return /filename="([^"]+)"/i.exec(header)?.[1] ?? null
}

/**
 * Выгрузка файлом (POST маршрута таблицы с телом): ответ сохраняется под именем из
 * `Content-Disposition`; ошибка — `ApiError`, как у `http`. Заголовки ответа —
 * вызывающему (счётчики выгрузки).
 */
export async function downloadFile<P extends ApiPath<'POST'>>(
  path: P,
  options: MethodTable<'POST'>[P]['args'][0],
  fallbackName = 'export',
): Promise<Headers> {
  const response = await send('POST', path, options as unknown as RawOptions)
  const name = dispositionName(response.headers.get('content-disposition')) ?? fallbackName
  saveBlob(await response.blob(), name)
  return response.headers
}
