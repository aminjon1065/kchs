import { EVENT_DOMAINS, EVENT_TYPES } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'

describe('домены событий', () => {
  it('выводятся из каталога: у каждого события каталога есть поток (ADR-0182)', () => {
    const domains = new Set(EVENT_DOMAINS)
    for (const type of EVENT_TYPES) expect(domains.has(type.split('.')[0] ?? '')).toBe(true)
    // Домены ядра — среди потоков; события модулей ядро по именам не знает
    expect([...domains]).toEqual(expect.arrayContaining(['object', 'acl', 'message', 'job']))
  })
})
