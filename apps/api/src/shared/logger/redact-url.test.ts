import { describe, expect, it } from 'vitest'
import { redactUrl } from './redact-url.js'

describe('адрес запроса в журнале (17-security.md §4)', () => {
  it('секрет входящего вебхука не попадает в журнал, а интеграция остаётся видна', () => {
    expect(redactUrl('/api/v1/hooks/8f1c0f7e-0000-4000-8000-000000000001/s3cr3t-value')).toBe(
      '/api/v1/hooks/8f1c0f7e-0000-4000-8000-000000000001/[скрыто]',
    )
  })

  it('токен входа правила автоматизации закрыт, номер правила остаётся', () => {
    expect(redactUrl('/api/v1/hooks/rules/rule-1/t0k3n')).toBe(
      '/api/v1/hooks/rules/rule-1/[скрыто]',
    )
  })

  it('токен гостевой ссылки закрыт, действие в пути остаётся', () => {
    expect(redactUrl('/api/v1/share/abcdef123456/open')).toBe('/api/v1/share/[скрыто]/open')
  })

  it('строка запроса вычищается целиком: там поисковые фразы', () => {
    expect(redactUrl('/api/v1/search?q=фамилия&limit=50')).toBe('/api/v1/search?[скрыто]')
  })

  it('обычный адрес не меняется', () => {
    expect(redactUrl('/api/v1/objects/8f1c0f7e-0000-4000-8000-000000000001')).toBe(
      '/api/v1/objects/8f1c0f7e-0000-4000-8000-000000000001',
    )
  })

  it('полный адрес из трассы чистится так же, происхождение сохраняется', () => {
    expect(redactUrl('http://kchs.local/api/v1/share/abcdef123456/open?p=1')).toBe(
      'http://kchs.local/api/v1/share/[скрыто]/open?[скрыто]',
    )
    expect(redactUrl('https://kchs.local')).toBe('https://kchs.local')
  })
})
