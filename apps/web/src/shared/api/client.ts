import type { ProblemDetails } from '@kchs/contracts'
import { normalizeLocale, translate } from '@kchs/i18n'

const BASE = '/api/v1'

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

export function getShareToken(): string | null {
  return shareToken
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

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | boolean | undefined | null>
  signal?: AbortSignal
  headers?: Record<string, string>
  /** Не перенаправлять на вход при 401 (используется самим экраном входа). */
  anonymous?: boolean
}

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

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const url = new URL(`${BASE}${path}`, window.location.origin)

  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }

  const headers: Record<string, string> = {
    accept: 'application/json',
    'accept-language': document.documentElement.lang || 'ru',
    ...options.headers,
  }

  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (method !== 'GET') {
    const token = getCsrfToken()
    if (token) headers['x-csrf-token'] = token
  }
  if (shareToken) headers['x-kchs-share-token'] = shareToken
  // Личные запросы идут от себя: иначе выход из режима был бы невозможен
  if (onBehalfOf && !path.startsWith('/me') && !path.startsWith('/auth')) {
    headers['x-kchs-on-behalf-of'] = onBehalfOf
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    credentials: 'same-origin',
    signal: options.signal,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })

  if (response.status === 204) return undefined as T

  const text = await response.text()
  const payload = text ? (JSON.parse(text) as unknown) : null

  if (!response.ok) {
    const problem = (payload ?? {
      type: 'about:blank',
      // Язык интерфейса отражён в <html lang>: клиент API не зависит от оболочки
      title: translate(normalizeLocale(document.documentElement.lang), 'errors.requestFailed'),
      status: response.status,
      code: 'internal_error',
    }) as ProblemDetails

    if (response.status === 401 && !options.anonymous) onUnauthorized?.()
    if (response.status === 403 && SETUP_CODES.has(problem.code)) onSetupRequired?.()
    throw new ApiError(problem)
  }

  return payload as T
}

export const http = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    api<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    api<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    api<T>(path, { ...options, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    api<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    api<T>(path, { ...options, method: 'DELETE', body }),
}
