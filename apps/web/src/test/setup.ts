import '@testing-library/jest-dom/vitest'
import { loadNamespaces, NAMESPACES } from '@kchs/i18n'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

/**
 * Окружение тестов компонентов (ADR-0209): все неймспейсы `ru` загружены, DOM чистится после
 * каждого теста, у happy-dom есть то, чего ждут примитивы Radix.
 */
await loadNamespaces('ru', NAMESPACES)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
})

// Radix Select и Popover зовут захват указателя и прокрутку к пункту
for (const name of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture'] as const) {
  if (!(name in Element.prototype)) {
    Object.defineProperty(Element.prototype, name, { value: () => false, configurable: true })
  }
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => undefined
}
