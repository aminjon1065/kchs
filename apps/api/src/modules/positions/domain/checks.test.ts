import { describe, expect, it } from 'vitest'
import { type CheckedPoint, checkPoints, distanceKm, MAX_AGE_MS } from './checks.js'

const NOW = Date.parse('2026-10-12T08:00:00Z')
const minute = 60_000

function point(
  index: number,
  minutesAgo: number,
  lat: number,
  lon: number,
  speed: number | null = null,
): CheckedPoint {
  return { index, device: 'T1', at: NOW - minutesAgo * minute, lat, lon, speed }
}

describe('проверки точек', () => {
  it('расстояние Душанбе — Худжанд около 200 км', () => {
    const km = distanceKm({ lat: 38.5598, lon: 68.787 }, { lat: 40.2826, lon: 69.6222 })
    expect(km).toBeGreaterThan(190)
    expect(km).toBeLessThan(215)
  })

  it('время из будущего и слишком давнее отбраковываются', () => {
    const rejected = checkPoints(
      [
        { index: 0, device: 'T1', at: NOW + 10 * minute, lat: 38.5, lon: 68.7, speed: null },
        {
          index: 1,
          device: 'T1',
          at: NOW - MAX_AGE_MS - minute,
          lat: 38.5,
          lon: 68.7,
          speed: null,
        },
        { index: 2, device: 'T1', at: NOW + minute, lat: 38.5, lon: 68.7, speed: null },
      ],
      new Map(),
      NOW,
    )
    expect(rejected.get(0)).toBe('future')
    expect(rejected.get(1)).toBe('too_old')
    expect(rejected.has(2)).toBe(false)
  })

  it('скачок быстрее 500 км/ч — от последней известной точки и внутри пакета', () => {
    const previous = new Map([['T1', { at: NOW - 10 * minute, lat: 38.56, lon: 68.79 }]])
    const rejected = checkPoints(
      [
        // 200 км за 5 минут — скачок
        point(0, 5, 40.28, 69.62),
        // 3 км за 8 минут от последней известной — едет
        point(1, 2, 38.58, 68.81),
        // заявленная устройством скорость невозможна
        point(2, 1, 38.58, 68.81, 900),
      ],
      previous,
      NOW,
    )
    expect(rejected.get(0)).toBe('impossible_speed')
    expect(rejected.has(1)).toBe(false)
    expect(rejected.get(2)).toBe('impossible_speed')
  })

  it('отбракованная точка не становится опорой следующей', () => {
    const rejected = checkPoints(
      [point(0, 9, 38.56, 68.79), point(1, 8, 40.28, 69.62), point(2, 7, 38.561, 68.791)],
      new Map(),
      NOW,
    )
    expect(rejected.get(1)).toBe('impossible_speed')
    expect(rejected.has(2)).toBe(false)
  })
})
