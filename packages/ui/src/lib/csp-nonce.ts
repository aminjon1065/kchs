import { setNonce as setStyleSingletonNonce } from 'get-nonce'
import { setNonce as setResizablePanelsNonce } from 'react-resizable-panels'

/**
 * Nonce CSP страницы (ADR-0043). Стили разрешены только файлами и элементами
 * <style> с nonce запроса, а библиотеки вставляют такие элементы во время работы:
 * Radix ScrollArea и Select — через проп `nonce`, react-remove-scroll (под
 * диалогами) — через get-nonce, react-resizable-panels — через свой setNonce.
 */
let current: string | undefined

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Nonce из `<meta name="csp-nonce">`: Caddy подставляет туда тот же UUID, что и в
 * заголовок CSP. На dev-сервере шаблон не обрабатывается — там nonce нет (и CSP тоже).
 */
export function readCspNonce(doc: Document = document): string | undefined {
  const value = doc.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? ''
  return UUID.test(value) ? value : undefined
}

/** Вызывается один раз при старте приложения, до первой отрисовки. */
export function setCspNonce(nonce: string | undefined): void {
  current = nonce
  if (!nonce) return
  setStyleSingletonNonce(nonce)
  setResizablePanelsNonce(nonce)
}

/** Nonce для пропа `nonce` компонентов, которые рисуют собственный <style>. */
export function cspNonce(): string | undefined {
  return current
}
