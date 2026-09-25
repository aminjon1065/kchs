import type { TaskSeriesRule } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { matchesRule, nextOccurrence } from './task-recurrence.js'

const TZ = 'Asia/Dushanbe'
const rule = (patch: Partial<TaskSeriesRule>): TaskSeriesRule => ({
  freq: 'weekly',
  interval: 1,
  weekdays: [5],
  monthDay: 1,
  time: '09:00',
  ...patch,
})

describe('правило повторения поручений', () => {
  it('еженедельно по пятницам в 09:00 по Душанбе', () => {
    // Четверг 24.09.2026, 12:00 по Душанбе (07:00 UTC)
    const next = nextOccurrence(
      rule({}),
      { startsOn: '2026-09-01', endsOn: null },
      new Date('2026-09-24T07:00:00Z'),
      TZ,
    )
    expect(next?.day).toBe('2026-09-25')
    expect(next?.at.toISOString()).toBe('2026-09-25T04:00:00.000Z')
    // В ту же пятницу после 09:00 — следующая неделя
    const after = nextOccurrence(
      rule({}),
      { startsOn: '2026-09-01', endsOn: null },
      new Date('2026-09-25T05:00:00Z'),
      TZ,
    )
    expect(after?.day).toBe('2026-10-02')
  })

  it('раз в две недели — от недели начала; ежедневно — через интервал', () => {
    const biweekly = rule({ interval: 2, weekdays: [1] })
    expect(matchesRule(biweekly, '2026-09-07', '2026-09-07')).toBe(true)
    expect(matchesRule(biweekly, '2026-09-07', '2026-09-14')).toBe(false)
    expect(matchesRule(biweekly, '2026-09-07', '2026-09-21')).toBe(true)
    const everyThird = rule({ freq: 'daily', interval: 3 })
    expect(matchesRule(everyThird, '2026-09-01', '2026-09-04')).toBe(true)
    expect(matchesRule(everyThird, '2026-09-01', '2026-09-05')).toBe(false)
  })

  it('ежемесячно: 31-е в коротком месяце и «последний день» — последнее число', () => {
    const on31 = rule({ freq: 'monthly', monthDay: 31 })
    expect(matchesRule(on31, '2026-01-31', '2026-02-28')).toBe(true)
    expect(matchesRule(on31, '2026-01-31', '2026-04-30')).toBe(true)
    const last = rule({ freq: 'monthly', monthDay: -1 })
    expect(matchesRule(last, '2026-01-01', '2028-02-29')).toBe(true)
  })

  it('окончание серии: после даты окончания экземпляров нет', () => {
    const next = nextOccurrence(
      rule({}),
      { startsOn: '2026-09-01', endsOn: '2026-09-30' },
      new Date('2026-09-25T05:00:00Z'),
      TZ,
    )
    expect(next).toBeNull()
  })
})
