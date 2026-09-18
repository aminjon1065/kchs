import { describe, expect, it } from 'vitest'
import { fromWall, metricWindows, toWall, wallDate, wallDateAfter } from './metric-period.js'

const TZ = 'Asia/Dushanbe'
const wall = (iso: string) => Date.parse(`${iso}Z`)
const window = (from: string, to: string) => ({ from: wall(from), to: wall(to) })

describe('окна показателя', () => {
  // 15 марта 2026, 10:00 по Душанбе (UTC+5)
  const now = new Date('2026-03-15T05:00:00Z')

  it('этот месяц: база — тот же отрезок прошлого месяца и прошлого года', () => {
    const month = { unit: 'month' as const, from: 0, to: 0 }
    const previous = metricWindows(month, 'previous_period', now, TZ)
    expect(previous.current).toEqual(window('2026-03-01T00:00:00', '2026-04-01T00:00:00'))
    expect(previous.base).toEqual(window('2026-02-01T00:00:00', '2026-02-15T10:00:00'))
    expect(previous.unit).toBe('month')

    const year = metricWindows(month, 'previous_year', now, TZ)
    expect(year.base).toEqual(window('2025-03-01T00:00:00', '2025-03-15T10:00:00'))

    expect(metricWindows(month, 'target', now, TZ).base).toBeNull()
    expect(metricWindows(month, 'none', now, TZ).base).toBeNull()
  })

  it('конец месяца: база не выходит за прошлый месяц', () => {
    const late = new Date('2026-03-31T10:00:00Z')
    const result = metricWindows({ unit: 'month', from: 0, to: 0 }, 'previous_period', late, TZ)
    expect(result.base).toEqual(window('2026-02-01T00:00:00', '2026-03-01T00:00:00'))
  })

  it('последние 30 дней и неделя: база той же длины', () => {
    const days = metricWindows({ unit: 'day', from: -29, to: 0 }, 'previous_period', now, TZ)
    expect(days.current).toEqual(window('2026-02-14T00:00:00', '2026-03-16T00:00:00'))
    expect(days.base).toEqual(window('2026-01-15T00:00:00', '2026-02-13T10:00:00'))

    // 15 марта 2026 — воскресенье: неделя с понедельника 9-го
    const week = metricWindows({ unit: 'week', from: 0, to: 0 }, 'previous_period', now, TZ)
    expect(week.current).toEqual(window('2026-03-09T00:00:00', '2026-03-16T00:00:00'))
    expect(week.base).toEqual(window('2026-03-02T00:00:00', '2026-03-08T10:00:00'))
  })

  it('законченный период сравнивается целиком', () => {
    const last = { unit: 'month' as const, from: -1, to: -1 }
    expect(metricWindows(last, 'previous_period', now, TZ).base).toEqual(
      window('2026-01-01T00:00:00', '2026-02-01T00:00:00'),
    )
    expect(metricWindows(last, 'previous_year', now, TZ).base).toEqual(
      window('2025-02-01T00:00:00', '2025-03-01T00:00:00'),
    )
    const quarters = metricWindows({ unit: 'quarter', from: -2, to: -1 }, 'none', now, TZ)
    expect(quarters.current).toEqual(window('2025-07-01T00:00:00', '2026-01-01T00:00:00'))
  })

  it('даты включительно; 29 февраля год назад — 28-е', () => {
    const february = { start: '2026-02-01', end: '2026-02-28' }
    const result = metricWindows(february, 'previous_period', now, TZ)
    expect(result.current).toEqual(window('2026-02-01T00:00:00', '2026-03-01T00:00:00'))
    expect(result.base).toEqual(window('2026-01-04T00:00:00', '2026-02-01T00:00:00'))
    expect(result.unit).toBeNull()

    const leap = metricWindows({ start: '2024-02-29', end: '2024-02-29' }, 'previous_year', now, TZ)
    expect(leap.base).toEqual(window('2023-02-28T00:00:00', '2023-03-01T00:00:00'))
  })

  it('всё время — без окон', () => {
    expect(metricWindows(null, 'previous_period', now, TZ)).toEqual({
      current: null,
      base: null,
      unit: null,
    })
  })
})

describe('настенное время', () => {
  it('переход на летнее время: границы месяца в своих смещениях', () => {
    const tz = 'Europe/Berlin'
    const now = new Date('2026-03-30T10:00:00Z')
    const { current } = metricWindows({ unit: 'month', from: 0, to: 0 }, 'none', now, tz)
    if (!current) throw new Error('нет окна')
    // 1 марта — ещё зимнее время (+1), 1 апреля — уже летнее (+2)
    expect(fromWall(current.from, tz).toISOString()).toBe('2026-02-28T23:00:00.000Z')
    expect(fromWall(current.to, tz).toISOString()).toBe('2026-03-31T22:00:00.000Z')
    expect(toWall(new Date('2026-03-29T01:30:00Z'), tz)).toBe(wall('2026-03-29T03:30:00'))
  })

  it('даты окна: неполный день входит целиком', () => {
    expect(wallDate(wall('2026-02-15T10:00:00'))).toBe('2026-02-15')
    expect(wallDateAfter(wall('2026-02-15T10:00:00'))).toBe('2026-02-16')
    expect(wallDateAfter(wall('2026-03-01T00:00:00'))).toBe('2026-03-01')
  })
})
