import type { FormSchedule } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import type { DayKindOf } from '~/kernel/business-calendar/working-days.js'
import { atTime, closedPeriods, dueAtOf, periodOf, recentPeriods } from './periods.js'

const TZ = 'Asia/Dushanbe'
/** Календарь без исключений: суббота и воскресенье — выходные. */
const plainCalendar: DayKindOf = () => undefined

const schedule = (patch: Partial<FormSchedule> = {}): FormSchedule => ({
  periodicity: 'daily',
  time: '08:00',
  dueMode: 'working',
  dueWorkingDays: 1,
  startsOn: null,
  dueOn: null,
  ...patch,
})

describe('периоды формы сбора данных', () => {
  it('день, неделя ISO и месяц опознаются по дате', () => {
    expect(periodOf('2026-09-19', 'daily')).toEqual({
      key: '2026-09-19',
      start: '2026-09-19',
      end: '2026-09-19',
    })
    // 19 сентября 2026 — суббота недели, начавшейся в понедельник 14-го
    expect(periodOf('2026-09-19', 'weekly')).toEqual({
      key: '2026-W38',
      start: '2026-09-14',
      end: '2026-09-20',
    })
    expect(periodOf('2026-09-19', 'monthly')).toEqual({
      key: '2026-09',
      start: '2026-09-01',
      end: '2026-09-30',
    })
  })

  it('последние периоды идут от нового к старому и не заходят раньше начала сбора', () => {
    const periods = recentPeriods('2026-09-19', schedule({ startsOn: '2026-09-17' }), 5)
    expect(periods.map((period) => period.key)).toEqual(['2026-09-19', '2026-09-18', '2026-09-17'])
  })

  it('текущий период к сдаче ещё не предлагается', () => {
    const closed = closedPeriods('2026-09-19', schedule(), 3)
    expect(closed.map((period) => period.key)).toEqual(['2026-09-18', '2026-09-17', '2026-09-16'])
  })

  it('срок ежедневной сводки — 08:00 следующего рабочего дня', () => {
    // Пятница 18 сентября: следующий рабочий день — понедельник 21-го
    const due = dueAtOf(periodOf('2026-09-18', 'daily'), schedule(), TZ, plainCalendar)
    expect(due.toISOString()).toBe(atTime('2026-09-21', '08:00', TZ).toISOString())
  })

  it('срок месячной сводки отсчитывается рабочими днями от конца месяца', () => {
    const due = dueAtOf(
      periodOf('2026-09-15', 'monthly'),
      schedule({ periodicity: 'monthly', dueWorkingDays: 3, time: '18:00' }),
      TZ,
      plainCalendar,
    )
    // 30 сентября 2026 — среда; три рабочих дня — понедельник 5 октября
    expect(due.toISOString()).toBe(atTime('2026-10-05', '18:00', TZ).toISOString())
  })

  it('календарные сроки: субботняя сводка — к 08:00 воскресенья, а не понедельника', () => {
    const calendar = schedule({ dueMode: 'calendar' })
    // Суббота 19 сентября 2026 → воскресенье 20-го
    const saturday = dueAtOf(periodOf('2026-09-19', 'daily'), calendar, TZ, plainCalendar)
    expect(saturday.toISOString()).toBe(atTime('2026-09-20', '08:00', TZ).toISOString())
    // Пятница 18-го → суббота 19-го; праздники календаря календарный срок не сдвигают
    const holiday: DayKindOf = (day) => (day === '2026-09-19' ? 'holiday' : undefined)
    const friday = dueAtOf(periodOf('2026-09-18', 'daily'), calendar, TZ, holiday)
    expect(friday.toISOString()).toBe(atTime('2026-09-19', '08:00', TZ).toISOString())
  })

  it('разовая форма — один период со своим днём срока', () => {
    const once = schedule({ periodicity: 'once', startsOn: '2026-09-01', dueOn: '2026-09-25' })
    const periods = recentPeriods('2026-09-19', once, 5)
    expect(periods).toEqual([{ key: 'once', start: '2026-09-01', end: '2026-09-25' }])
    expect(dueAtOf(periods[0] as never, once, TZ, plainCalendar).toISOString()).toBe(
      atTime('2026-09-25', '08:00', TZ).toISOString(),
    )
  })
})
