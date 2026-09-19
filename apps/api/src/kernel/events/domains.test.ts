import { EVENT_TYPES } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { KNOWN_DOMAINS } from './consumer.js'

describe('домены событий', () => {
  it('у каждого события каталога известный домен: подписчики «*» читают его поток', () => {
    const known = new Set<string>(KNOWN_DOMAINS)
    const domains = new Set(EVENT_TYPES.map((type) => type.split('.')[0] ?? ''))
    expect([...domains].filter((domain) => !known.has(domain))).toEqual([])
  })
})
