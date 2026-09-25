import { describe, expect, it } from 'vitest'
import { AllowedDomain, domainAllowed, normalizeDomain, SecurityPolicy } from '../security.js'

describe('белый список адресатов правил (ADR-0141)', () => {
  it('домен приводится к виду kchs.tj, как бы его ни вставили', () => {
    expect(normalizeDomain('@Kchs.TJ')).toBe('kchs.tj')
    expect(normalizeDomain('https://Hooks.Partner.tj/in?x=1')).toBe('hooks.partner.tj')
    expect(normalizeDomain('*.gdacs.org')).toBe('gdacs.org')
    expect(normalizeDomain('mchs.gov.ru.')).toBe('mchs.gov.ru')
    expect(normalizeDomain('api.example.org:8443')).toBe('api.example.org')
    expect(AllowedDomain.safeParse('не домен').success).toBe(false)
    expect(AllowedDomain.safeParse('localhost').success).toBe(false)
  })

  it('совпадает сам домен и поддомены, но не соседний с тем же хвостом', () => {
    const domains = ['kchs.tj', 'partner.tj']
    expect(domainAllowed('kchs.tj', domains)).toBe(true)
    expect(domainAllowed('Hooks.KCHS.tj', domains)).toBe(true)
    expect(domainAllowed('evilkchs.tj', domains)).toBe(false)
    expect(domainAllowed('kchs.tj.evil.org', domains)).toBe(false)
    expect(domainAllowed('', domains)).toBe(false)
    expect(domainAllowed('kchs.tj', [])).toBe(false)
  })

  it('по умолчанию списки пусты — правилам можно писать только сотрудникам', () => {
    expect(SecurityPolicy.parse({})).toMatchObject({ ruleEmailDomains: [], ruleWebhookDomains: [] })
  })
})
