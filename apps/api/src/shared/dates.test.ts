import { describe, expect, it } from 'vitest'
import { localToday } from './dates.js'

describe('дата в поясе установки (ADR-0229)', () => {
  it('с 00:00 до 05:00 по Душанбе — уже сегодняшняя, а не вчерашняя по UTC', () => {
    // 2 часа ночи 15 марта по Душанбе = 21:00 14 марта по UTC
    const night = new Date('2026-03-14T21:00:00Z')
    expect(night.toISOString().slice(0, 10)).toBe('2026-03-14')
    expect(localToday(night, 'Asia/Dushanbe')).toBe('2026-03-15')
  })
})
