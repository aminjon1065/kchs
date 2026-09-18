import { describe, expect, it } from 'vitest'
import { cspNonce, readCspNonce, setCspNonce } from './csp-nonce.js'

/** Документ с одним <meta name="csp-nonce"> (или без него). */
const page = (content: string | null) =>
  ({
    querySelector: () => (content === null ? null : { content }),
  }) as unknown as Document

describe('nonce CSP страницы', () => {
  it('берёт UUID, подставленный Caddy в <meta>', () => {
    const nonce = '218324b3-2129-4f74-b43e-a0f81357f4ae'
    expect(readCspNonce(page(nonce))).toBe(nonce)
    setCspNonce(nonce)
    expect(cspNonce()).toBe(nonce)
  })

  it('необработанный шаблон dev-сервера и посторонние значения — без nonce', () => {
    expect(readCspNonce(page('{{placeholder `http.request.uuid`}}'))).toBeUndefined()
    expect(readCspNonce(page('"><script>alert(1)</script>'))).toBeUndefined()
    expect(readCspNonce(page(''))).toBeUndefined()
    expect(readCspNonce(page(null))).toBeUndefined()
  })
})
