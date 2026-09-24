import type { FormEscalation } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import type { DayKindOf } from '~/kernel/business-calendar/working-days.js'
import { type FormStage, planStages, stageMoments } from './form-deadlines.js'

const TZ = 'Asia/Dushanbe'
const plainCalendar: DayKindOf = () => undefined
const escalation: FormEscalation = { enabled: true, afterWorkingDays: 1 }

/** Срок — понедельник 21 сентября 2026, 08:00 в поясе установки. */
const due = new Date('2026-09-21T03:00:00.000Z')
const none = new Set<FormStage>()

describe('этапы контроля сдачи', () => {
  it('срок к 08:00 напоминает утром предыдущего рабочего дня', () => {
    const moments = stageMoments(due, TZ, plainCalendar, escalation)
    // Пятница 18 сентября, 09:00 в поясе установки (UTC+5)
    expect(moments.due_soon.toISOString()).toBe('2026-09-18T04:00:00.000Z')
    expect(moments.overdue.getTime()).toBe(due.getTime())
    // Эскалация — утро следующего рабочего дня, вторника
    expect(moments.escalated.toISOString()).toBe('2026-09-22T04:00:00.000Z')
  })

  it('срок в конце дня напоминает утром того же дня', () => {
    const evening = new Date('2026-09-21T13:00:00.000Z')
    const moments = stageMoments(evening, TZ, plainCalendar, escalation)
    expect(moments.due_soon.toISOString()).toBe('2026-09-21T04:00:00.000Z')
  })

  it('до срока отправляется напоминание, после — просрочка', () => {
    const before = planStages(
      { dueAt: due, done: none },
      new Date(due.getTime() - 60_000),
      TZ,
      plainCalendar,
      escalation,
    )
    expect(before.fire).toEqual(['due_soon'])

    const after = planStages(
      { dueAt: due, done: none },
      new Date(due.getTime() + 60_000),
      TZ,
      plainCalendar,
      escalation,
    )
    expect(after.fire).toEqual(['overdue'])
    // Напоминание уже бессмысленно: этап отмечается без отправки
    expect(after.skip).toEqual(['due_soon'])
  })

  it('эскалация приходит после просрочки и один раз', () => {
    const at = new Date('2026-09-22T05:00:00.000Z')
    const plan = planStages(
      { dueAt: due, done: new Set<FormStage>(['due_soon', 'overdue']) },
      at,
      TZ,
      plainCalendar,
      escalation,
    )
    expect(plan.fire).toEqual(['escalated'])

    const again = planStages(
      { dueAt: due, done: new Set<FormStage>(['due_soon', 'overdue', 'escalated']) },
      at,
      TZ,
      plainCalendar,
      escalation,
    )
    expect(again.fire).toEqual([])
  })

  it('календарные сроки: напоминание за два часа, эскалация через час — и в выходной', () => {
    // Срок — воскресенье 20 сентября 2026, 08:00 в поясе установки
    const sunday = new Date('2026-09-20T03:00:00.000Z')
    const now = { enabled: true, afterWorkingDays: 0 }
    const moments = stageMoments(sunday, TZ, plainCalendar, now, 'calendar')
    expect(moments.due_soon.toISOString()).toBe('2026-09-20T01:00:00.000Z')
    expect(moments.overdue.getTime()).toBe(sunday.getTime())
    expect(moments.escalated.toISOString()).toBe('2026-09-20T04:00:00.000Z')

    const plan = planStages(
      { dueAt: sunday, done: new Set<FormStage>(['due_soon']) },
      new Date('2026-09-20T04:30:00.000Z'),
      TZ,
      plainCalendar,
      now,
      'calendar',
    )
    expect(plan.fire).toEqual(['overdue', 'escalated'])
  })

  it('календарные сроки с днями на эскалацию — 09:00 через N календарных дней', () => {
    const saturday = new Date('2026-09-19T03:00:00.000Z')
    const moments = stageMoments(
      saturday,
      TZ,
      plainCalendar,
      { enabled: true, afterWorkingDays: 1 },
      'calendar',
    )
    // Воскресенье 20-го, 09:00 — выходной не пропускается
    expect(moments.escalated.toISOString()).toBe('2026-09-20T04:00:00.000Z')
  })

  it('выключенная эскалация не наступает', () => {
    const plan = planStages(
      { dueAt: due, done: new Set<FormStage>(['due_soon', 'overdue']) },
      new Date('2026-09-30T05:00:00.000Z'),
      TZ,
      plainCalendar,
      { enabled: false, afterWorkingDays: 1 },
    )
    expect(plan.fire).toEqual([])
  })
})
