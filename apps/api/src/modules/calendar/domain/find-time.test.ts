import { describe, expect, it } from 'vitest'
import { busyDuring, type FindSlotsInput, findSlots, mergeIntervals } from './find-time.js'

const at = (value: string) => Date.parse(value)
const HOURS = { start: '09:00', end: '18:00' }
const weekdays = (date: string) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())

function input(extra: Partial<FindSlotsInput>): FindSlotsInput {
  return {
    // Понедельник 21 сентября 2026, весь день по Душанбе
    from: at('2026-09-21T00:00:00+05:00'),
    to: at('2026-09-26T00:00:00+05:00'),
    durationMs: 3_600_000,
    stepMinutes: 30,
    notBefore: at('2026-09-20T00:00:00Z'),
    required: [],
    optional: [],
    resources: [],
    workingHoursOnly: true,
    isWorkingDay: weekdays,
    timezone: 'Asia/Dushanbe',
    limit: 5,
    perDay: 3,
    ...extra,
  }
}

const local = (instant: number) =>
  new Date(instant + 5 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')

describe('подбор времени', () => {
  it('занятость сливается и проверяется по пересечению', () => {
    const busy = mergeIntervals([
      { start: 30, end: 40 },
      { start: 10, end: 20 },
      { start: 15, end: 25 },
    ])
    expect(busy).toEqual([
      { start: 10, end: 25 },
      { start: 30, end: 40 },
    ])
    expect(busyDuring(busy, 0, 10)).toBe(false)
    expect(busyDuring(busy, 24, 30)).toBe(true)
    expect(busyDuring(busy, 25, 30)).toBe(false)
    expect(busyDuring(busy, 41, 50)).toBe(false)
  })

  it('окна, свободные у всех, в рабочие часы; не больше трёх в день', () => {
    const slots = findSlots(
      input({
        required: [
          {
            timezone: 'Asia/Dushanbe',
            workingHours: HOURS,
            busy: [
              { start: at('2026-09-21T10:00:00+05:00'), end: at('2026-09-21T11:00:00+05:00') },
            ],
          },
          {
            timezone: 'Asia/Dushanbe',
            workingHours: HOURS,
            busy: [
              { start: at('2026-09-21T11:30:00+05:00'), end: at('2026-09-21T12:00:00+05:00') },
            ],
          },
        ],
      }),
    )
    expect(slots.map((slot) => local(slot.start))).toEqual([
      '2026-09-21 09:00',
      '2026-09-21 12:00',
      '2026-09-21 13:00',
      '2026-09-22 09:00',
      '2026-09-22 10:00',
    ])
  })

  it('выходные и праздники производственного календаря пропускаются', () => {
    const slots = findSlots(
      input({
        from: at('2026-09-26T00:00:00+05:00'),
        to: at('2026-09-30T00:00:00+05:00'),
        required: [{ timezone: 'Asia/Dushanbe', workingHours: HOURS, busy: [] }],
        // Понедельник 28-го — праздник
        isWorkingDay: (date) => weekdays(date) && date !== '2026-09-28',
        limit: 1,
      }),
    )
    expect(slots.map((slot) => local(slot.start))).toEqual(['2026-09-29 09:00'])
  })

  it('рабочие часы в разных поясах: пересечение Москвы и Душанбе', () => {
    const slots = findSlots(
      input({
        required: [
          { timezone: 'Asia/Dushanbe', workingHours: HOURS, busy: [] },
          { timezone: 'Europe/Moscow', workingHours: HOURS, busy: [] },
        ],
        limit: 1,
      }),
    )
    // 09:00 по Москве — 11:00 по Душанбе
    expect(slots.map((slot) => local(slot.start))).toEqual(['2026-09-21 11:00'])
  })

  it('ресурс занят — окно не предлагается; необязательные считаются', () => {
    const slots = findSlots(
      input({
        required: [{ timezone: 'Asia/Dushanbe', workingHours: HOURS, busy: [] }],
        optional: [
          {
            timezone: 'Asia/Dushanbe',
            workingHours: HOURS,
            busy: [
              { start: at('2026-09-21T10:00:00+05:00'), end: at('2026-09-21T10:30:00+05:00') },
            ],
          },
        ],
        resources: [
          [{ start: at('2026-09-21T09:00:00+05:00'), end: at('2026-09-21T10:00:00+05:00') }],
        ],
        limit: 2,
      }),
    )
    expect(slots.map((slot) => [local(slot.start), slot.optionalBusy])).toEqual([
      ['2026-09-21 10:00', 1],
      ['2026-09-21 11:00', 0],
    ])
  })

  it('без ограничения рабочими часами — любое время, но не в прошлом', () => {
    const slots = findSlots(
      input({
        required: [{ timezone: 'Asia/Dushanbe', workingHours: HOURS, busy: [] }],
        workingHoursOnly: false,
        notBefore: at('2026-09-21T20:10:00+05:00'),
        limit: 1,
      }),
    )
    expect(slots.map((slot) => local(slot.start))).toEqual(['2026-09-21 20:30'])
  })
})
