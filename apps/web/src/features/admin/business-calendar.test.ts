import { describe, expect, it } from 'vitest'
import { workingDaysIn } from './business-calendar-section.js'

describe('производственный календарь в консоли', () => {
  it('рабочие дни года: пн–пт с поправками на праздники, переносы и рабочие субботы', () => {
    // 2026: 365 дней, 104 субботы и воскресенья → 261 будний день
    expect(workingDaysIn(2026, [])).toBe(261)
    expect(
      workingDaysIn(2026, [
        { day: '2026-01-01', kind: 'holiday', note: null }, // четверг
        { day: '2026-01-02', kind: 'weekend', note: null }, // пятница, перенос
        { day: '2026-01-03', kind: 'work', note: null }, // суббота, рабочая
        { day: '2026-03-07', kind: 'short', note: null }, // суббота, сокращённый рабочий
        { day: '2026-03-08', kind: 'holiday', note: null }, // воскресенье — и так выходной
      ]),
    ).toBe(261 - 2 + 2)
  })
})
