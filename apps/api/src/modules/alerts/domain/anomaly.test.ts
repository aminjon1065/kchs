import type { AlertAnomalyCondition } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { anomaly, changePercent, compare, type SeriesPoint } from './anomaly.js'

const condition = (patch: Partial<AlertAnomalyCondition> = {}): AlertAnomalyCondition => ({
  kind: 'anomaly',
  z: 3,
  points: 30,
  seasonality: 'none',
  ...patch,
})

/** Ряд по дням; по умолчанию — от вторника 1 сентября 2026. */
function series(values: Array<number | null>, start = Date.UTC(2026, 8, 1)): SeriesPoint[] {
  return values.map((value, index) => ({
    period: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    value,
  }))
}

describe('условия алертов', () => {
  it('порог сравнивает значение с числом', () => {
    expect(compare(10, 'gt', 5)).toBe(true)
    expect(compare(5, 'gte', 5)).toBe(true)
    expect(compare(5, 'lt', 5)).toBe(false)
  })

  it('изменение в процентах считается от модуля базы', () => {
    expect(changePercent(120, 100)).toBe(20)
    expect(changePercent(80, 100)).toBe(-20)
    expect(changePercent(5, 0)).toBeNull()
    expect(changePercent(null, 100)).toBeNull()
  })

  it('ровный ряд без разброса аномалией не считается', () => {
    const result = anomaly(series([10, 10, 10, 10, 10, 10]), condition())
    expect(result.score).toBeNull()
    expect(result.reason).toBe('история без разброса')
  })

  it('выброс в конце ряда даёт большое отклонение', () => {
    const result = anomaly(series([10, 11, 9, 10, 11, 9, 10, 40]), condition())
    expect(result.score).not.toBeNull()
    expect(Math.abs(result.score as number)).toBeGreaterThan(3)
    expect(result.value).toBe(40)
  })

  it('короткой истории не хватает для оценки', () => {
    const result = anomaly(series([10, 12, 40]), condition())
    expect(result.score).toBeNull()
    expect(result.reason).toContain('4')
  })

  it('недельная сезонность сравнивает точку с теми же днями недели', () => {
    // Понедельник 24 августа 2026 и ещё 28 дней: понедельники высокие, прочие дни низкие
    const mondays = [58, 62, 60, 61, 60]
    const values = Array.from({ length: 29 }, (_, index) =>
      index % 7 === 0 ? (mondays[index / 7] as number) : 10,
    )
    const points = series(values, Date.UTC(2026, 7, 24))
    expect(points[28]?.period).toBe('2026-09-21')

    const flat = anomaly(points, condition())
    const seasonal = anomaly(points, condition({ seasonality: 'weekly' }))
    // Без сезонности понедельник выглядит выбросом, с сезонностью — обычным днём
    expect(Math.abs(flat.score as number)).toBeGreaterThan(2)
    expect(Math.abs(seasonal.score as number)).toBeLessThan(1)
  })
})
