import type { BusinessDayKind } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { endOfLocalDay } from '~/kernel/business-calendar/working-days.js'
import { calendarSpan, planStages, type ReminderStage, stageMoments } from './task-deadlines.js'

const TZ = 'Asia/Dushanbe'
/** Проверочный праздник: понедельник 5 октября 2026 (UTC+5 — утро 09:00 = 04:00Z). */
const HOLIDAYS: Record<string, BusinessDayKind> = { '2026-10-05': 'holiday' }
const kindOf = (day: string) => HOLIDAYS[day]

/** Срок — конец среды 7 октября по Душанбе. */
const DUE = endOfLocalDay('2026-10-07', TZ)
const at = (iso: string) => new Date(iso)
const done = (...stages: ReminderStage[]) => new Set(stages)
const facts = (dueSetAt: string, stages = done()) => ({
  dueAt: DUE,
  dueSetAt: at(dueSetAt),
  done: stages,
})

describe('моменты этапов срока по производственному календарю', () => {
  it('за 3 и за 1 рабочий день — утром, праздник пропускается; просрочка — утро следующего рабочего дня', () => {
    const moments = stageMoments(DUE, TZ, kindOf, { enabled: true, afterWorkingDays: 1 })
    expect(moments.dueDate).toBe('2026-10-07')
    // Вт 06 — 1-й, пн 05 — праздник, пт 02 — 2-й, чт 01 — 3-й рабочий день до срока
    expect(moments.d3.toISOString()).toBe('2026-10-01T04:00:00.000Z')
    expect(moments.d1.toISOString()).toBe('2026-10-06T04:00:00.000Z')
    expect(moments.today.toISOString()).toBe('2026-10-07T04:00:00.000Z')
    expect(moments.overdue.toISOString()).toBe('2026-10-08T04:00:00.000Z')
    expect(moments.escalated.toISOString()).toBe('2026-10-09T04:00:00.000Z')
    // Эскалация «сразу» — вместе с просрочкой
    const now = stageMoments(DUE, TZ, kindOf, { enabled: true, afterWorkingDays: 0 })
    expect(now.escalated.toISOString()).toBe(now.overdue.toISOString())
  })

  it('срок в пятницу: просрочка и эскалация — в понедельник и вторник, праздник — дальше', () => {
    const friday = endOfLocalDay('2026-10-02', TZ)
    const moments = stageMoments(friday, TZ, kindOf, { enabled: true, afterWorkingDays: 1 })
    // Пн 05 — праздник: просрочка во вторник 06, эскалация в среду 07
    expect(moments.overdue.toISOString()).toBe('2026-10-06T04:00:00.000Z')
    expect(moments.escalated.toISOString()).toBe('2026-10-07T04:00:00.000Z')
  })
})

describe('что отправить на проходе задания', () => {
  const escalation = { enabled: true, afterWorkingDays: 1 }
  const plan = (now: string, value: ReturnType<typeof facts>, settings = escalation) =>
    planStages(value, at(now), TZ, kindOf, settings)

  it('утро третьего рабочего дня до срока — «за 3 дня», дней до срока — 3', () => {
    const result = plan('2026-10-01T05:00:00Z', facts('2026-09-25T06:00:00Z'))
    expect(result.fire).toEqual(['d3'])
    expect(result.skip).toEqual([])
    expect(result.workingDaysLeft).toBe(3)
  })

  it('воркер стоял: отправляется только последний наступивший этап, прежние — пропущены', () => {
    const result = plan('2026-10-06T05:00:00Z', facts('2026-09-25T06:00:00Z'))
    expect(result.fire).toEqual(['d1'])
    expect(result.skip).toEqual(['d3'])
  })

  it('этап раньше установки срока не наступает: о сроке сообщило назначение', () => {
    const result = plan('2026-10-02T05:00:00Z', facts('2026-10-01T07:00:00Z'))
    expect(result.fire).toEqual([])
    expect(result.skip).toEqual([])
  })

  it('отправленный этап не повторяется', () => {
    expect(
      plan('2026-10-06T05:00:00Z', facts('2026-09-25T06:00:00Z', done('d3', 'd1'))).fire,
    ).toEqual([])
  })

  it('день срока — «срок сегодня», до срока — ни просрочки, ни эскалации', () => {
    const result = plan('2026-10-07T10:00:00Z', facts('2026-09-25T06:00:00Z', done('d3', 'd1')))
    expect(result.fire).toEqual(['today'])
    expect(result.workingDaysLeft).toBe(0)
  })

  it('просрочка — утром следующего рабочего дня, эскалация — ещё через рабочий день', () => {
    const early = done('d3', 'd1', 'today')
    expect(plan('2026-10-08T03:00:00Z', facts('2026-09-25T06:00:00Z', early)).fire).toEqual([])
    expect(plan('2026-10-08T05:00:00Z', facts('2026-09-25T06:00:00Z', early)).fire).toEqual([
      'overdue',
    ])
    expect(
      plan('2026-10-09T05:00:00Z', facts('2026-09-25T06:00:00Z', done('overdue'))).fire,
    ).toEqual(['escalated'])
    // Воркер стоял — просрочка и эскалация уходят одним проходом
    expect(plan('2026-10-09T05:00:00Z', facts('2026-09-25T06:00:00Z')).fire).toEqual([
      'overdue',
      'escalated',
    ])
  })

  it('эскалация выключена настройкой — только просрочка', () => {
    const result = plan('2026-10-12T05:00:00Z', facts('2026-09-25T06:00:00Z'), {
      enabled: false,
      afterWorkingDays: 1,
    })
    expect(result.fire).toEqual(['overdue'])
  })

  it('промежуток календаря для пачки сроков — с запасом на праздники и эскалацию', () => {
    expect(calendarSpan([], TZ)).toBeNull()
    expect(calendarSpan([DUE, endOfLocalDay('2026-12-30', TZ)], TZ, escalation)).toEqual({
      from: '2026-09-07',
      to: '2027-01-31',
    })
  })
})
