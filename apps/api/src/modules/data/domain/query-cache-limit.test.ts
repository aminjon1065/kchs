import { describe, expect, it } from 'vitest'
import { CACHE_MAX_BYTES, CACHE_MAX_ROWS, fitsCache } from './query-service.js'

/** Большой результат запроса не кладётся в кэш одним ключом (ADR-0220). */
describe('предел кэшируемого результата', () => {
  it('сводка и плитка дашборда — в кэш', () => {
    expect(fitsCache(20, 4_000)).toBe(true)
    expect(fitsCache(CACHE_MAX_ROWS, CACHE_MAX_BYTES)).toBe(true)
  })

  it('много строк или много байт — мимо кэша', () => {
    expect(fitsCache(CACHE_MAX_ROWS + 1, 10_000)).toBe(false)
    expect(fitsCache(500, CACHE_MAX_BYTES + 1)).toBe(false)
    expect(fitsCache(50_000, 40_000_000)).toBe(false)
  })
})
