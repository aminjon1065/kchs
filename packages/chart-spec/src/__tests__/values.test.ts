import { describe, expect, it } from 'vitest'
import { histogramBins, lttb, niceStep, topN } from '../transform.js'
import {
  addBucket,
  detectBucket,
  periodSequence,
  previousYear,
  toNumber,
  toWallClock,
} from '../values.js'

const utc = (s: string) => Date.parse(`${s}Z`)

describe('значения', () => {
  it('numeric и bigint из драйвера читаются как числа', () => {
    expect(toNumber('12.5')).toBe(12.5)
    expect(toNumber(10n)).toBe(10)
    expect(toNumber('')).toBeNull()
    expect(toNumber('abc')).toBeNull()
    expect(toNumber(Number.NaN)).toBeNull()
  })

  it('настенное время: момент — в поясе платформы, календарная дата — без сдвига', () => {
    // 2026-03-12T20:30Z в Душанбе (UTC+5) — 13 марта 01:30
    expect(toWallClock('2026-03-12T20:30:00Z', 'Asia/Dushanbe')).toBe(utc('2026-03-13T01:30:00'))
    expect(toWallClock('2026-03-12', 'Asia/Dushanbe')).toBe(utc('2026-03-12T00:00:00'))
    expect(toWallClock(null, 'Asia/Dushanbe')).toBeNull()
  })

  it('гранулярность ряда определяется по данным', () => {
    const at = (list: string[]) => list.map((s) => utc(`${s}T00:00:00`))
    expect(detectBucket(at(['2024-01-01', '2025-01-01', '2026-01-01']))).toBe('year')
    expect(detectBucket(at(['2026-01-01', '2026-04-01', '2026-07-01']))).toBe('quarter')
    expect(detectBucket(at(['2026-01-01', '2026-02-01', '2026-04-01']))).toBe('month')
    expect(detectBucket(at(['2026-03-02', '2026-03-09', '2026-03-16']))).toBe('week')
    expect(detectBucket(at(['2026-03-02', '2026-03-03', '2026-03-05']))).toBe('day')
    expect(detectBucket([utc('2026-03-02T10:00:00'), utc('2026-03-02T11:00:00')])).toBe('hour')
    expect(detectBucket([utc('2026-03-02T10:17:00'), utc('2026-03-02T11:00:00')])).toBeNull()
  })

  it('последовательность периодов заполняет пропуски', () => {
    const seq = periodSequence(utc('2026-01-01T00:00:00'), utc('2026-04-01T00:00:00'), 'month')
    expect(seq?.map((t) => new Date(t).toISOString().slice(0, 10))).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
    ])
    expect(addBucket(utc('2026-01-01T00:00:00'), 'quarter', -1)).toBe(utc('2025-10-01T00:00:00'))
    expect(periodSequence(0, 10 * 86_400_000, 'hour', 100)).toBeNull()
  })

  it('год назад: 29 февраля — на 28-е', () => {
    expect(previousYear(utc('2028-02-29T00:00:00'))).toBe(utc('2027-02-28T00:00:00'))
    expect(previousYear(utc('2026-06-01T00:00:00'))).toBe(utc('2025-06-01T00:00:00'))
  })
})

describe('преобразования', () => {
  it('top-N сохраняет исходный порядок оставшихся', () => {
    const weights: Record<string, number> = { a: 1, b: 9, c: 5, d: -7 }
    expect(topN(['a', 'b', 'c', 'd'], (k) => weights[k] ?? 0, 2)).toEqual({
      kept: ['b', 'd'],
      folded: ['a', 'c'],
    })
  })

  it('корзины гистограммы: круглый шаг, правая граница включена', () => {
    expect(niceStep(7)).toBe(10)
    expect(niceStep(0.23)).toBe(0.25)
    const bins = histogramBins([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)
    expect(bins.map((b) => [b.from, b.to])).toEqual([
      [0, 2],
      [2, 4],
      [4, 6],
      [6, 8],
      [8, 10],
    ])
    expect(bins.reduce((n, b) => n + b.count, 0)).toBe(11)
    expect(bins.at(-1)?.count).toBe(3)
    expect(histogramBins([5, 5, 5])).toEqual([{ from: 5, to: 5, count: 3 }])
  })

  it('LTTB оставляет концы и пики', () => {
    const xs = Array.from({ length: 1000 }, (_, i) => i)
    const ys = xs.map((x) => (x === 500 ? 100 : Math.sin(x / 50)))
    const kept = lttb(xs, ys, 50)
    expect(kept).toHaveLength(50)
    expect(kept[0]).toBe(0)
    expect(kept.at(-1)).toBe(999)
    expect(kept).toContain(500)
    expect(lttb([1, 2, 3], [1, 2, 3], 10)).toEqual([0, 1, 2])
  })
})
