/**
 * Состояние сессии клиента API: CSRF-токен, токен гостевой ссылки, режим «от имени» и
 * обработчики ответов оболочки. Отдельно от транспорта (`client.ts`): оболочка и экраны
 * входа задают состояние, а вызывать API напрямую не должны (ADR-0183).
 */

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

type Handler = () => void

let onUnauthorized: Handler | null = null

/**
 * Незавершённая настройка входа (временный пароль, обязательный второй фактор):
 * сервер отвечает 403 с кодом — оболочка перечитывает профиль и показывает
 * нужный экран. Так политика, включённая во время работы, применяется сразу.
 */
let onSetupRequired: Handler | null = null

export function setSetupRequiredHandler(handler: Handler | null): void {
  onSetupRequired = handler
}

export function setUnauthorizedHandler(handler: Handler | null): void {
  onUnauthorized = handler
}

/** Ответ 401 на запрос не экрана входа — оболочке. */
export function notifyUnauthorized(): void {
  onUnauthorized?.()
}

/** Ответ 403 с кодом незавершённой настройки входа — оболочке. */
export function notifySetupRequired(): void {
  onSetupRequired?.()
}
