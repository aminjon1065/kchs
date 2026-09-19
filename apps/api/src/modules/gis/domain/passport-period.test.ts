import { describe, expect, it } from 'vitest'
import { periodPlan } from './passport-period.js'

// 31 декабря 2025 года, 20:30 UTC — в Душанбе (UTC+5) уже 1 января 2026 года
const NEW_YEAR = new Date('2025-12-31T20:30:00Z')

describe('период паспорта территории', () => {
  it('12 месяцев: текущий месяц в поясе пользователя и 12 месяцев перед окном', () => {
    const plan = periodPlan('12m', NEW_YEAR, 'Asia/Dushanbe')
    expect(plan.window).toEqual({ from: '2025-02-01', to: '2026-01-31' })
    expect(plan.previousWindow).toEqual({ from: '2024-02-01', to: '2025-01-31' })
    expect(plan.both).toEqual({ unit: 'month', from: -23, to: 0 })
    expect(plan.current).toEqual({ unit: 'month', from: -11, to: 0 })
    expect(plan.months).toHaveLength(12)
    expect(plan.months[0]).toBe('2025-02-01')
    expect(plan.months.at(-1)).toBe('2026-01-01')
    // В UTC это ещё декабрь
    expect(periodPlan('12m', NEW_YEAR, 'UTC').window).toEqual({
      from: '2025-01-01',
      to: '2025-12-31',
    })
  })

  it('год: текущий календарный год и прошлый, февраль високосного года', () => {
    const plan = periodPlan('year', new Date('2024-03-10T12:00:00Z'), 'Asia/Dushanbe')
    expect(plan.window).toEqual({ from: '2024-01-01', to: '2024-12-31' })
    expect(plan.previousWindow).toEqual({ from: '2023-01-01', to: '2023-12-31' })
    expect(plan.both).toEqual({ unit: 'year', from: -1, to: 0 })
    expect(plan.months[1]).toBe('2024-02-01')
    expect(periodPlan('12m', new Date('2024-02-10T12:00:00Z'), 'UTC').window?.to).toBe('2024-02-29')
  })

  it('всё время — без окон и сравнения', () => {
    expect(periodPlan('all', NEW_YEAR, 'Asia/Dushanbe')).toEqual({
      window: null,
      previousWindow: null,
      both: null,
      current: null,
      months: [],
    })
  })
})
