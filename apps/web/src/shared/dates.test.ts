import { describe, expect, it } from 'vitest'
import { localIsoDay } from './dates.js'

describe('дата «сегодня» в поясе браузера (ADR-0229)', () => {
  it('два часа ночи по местному времени — уже сегодняшняя дата', () => {
    // Местное 02:00 15 марта: у пояса +05 это 21:00 14 марта по UTC
    expect(localIsoDay(new Date(2026, 2, 15, 2, 0))).toBe('2026-03-15')
    expect(localIsoDay(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31')
  })
})
