import { createTranslator } from '@kchs/i18n'
import { describe, expect, it } from 'vitest'
import {
  buildRule,
  describeRule,
  nthWeekday,
  parseRule,
  presetOf,
  presetRule,
  type RepeatRule,
} from './recurrence.js'

const t = createTranslator('ru')
const date = (value: string) => value.split('-').reverse().join('.')
const describe_ = (rule: RepeatRule | null) => describeRule(rule, t, 'ru-RU', date)

describe('повтор события в форме', () => {
  it('пресеты от даты начала: четверг 24 сентября 2026', () => {
    expect(buildRule(presetRule('weekly', '2026-09-24') as RepeatRule)).toBe('FREQ=WEEKLY;BYDAY=TH')
    expect(buildRule(presetRule('weekdays', '2026-09-24') as RepeatRule)).toBe(
      'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    )
    expect(buildRule(presetRule('monthly', '2026-09-24') as RepeatRule)).toBe(
      'FREQ=MONTHLY;BYMONTHDAY=24',
    )
    // 24 сентября — последний четверг месяца
    expect(buildRule(presetRule('monthlyNth', '2026-09-24') as RepeatRule)).toBe(
      'FREQ=MONTHLY;BYDAY=-1TH',
    )
    expect(presetRule('none', '2026-09-24')).toBeNull()
  })

  it('n-й день недели месяца: 1…4 или последний', () => {
    expect(nthWeekday('2026-09-01')).toEqual({ nth: 1, day: 'TU' })
    expect(nthWeekday('2026-09-15')).toEqual({ nth: 3, day: 'TU' })
    expect(nthWeekday('2026-09-29')).toEqual({ nth: -1, day: 'TU' })
  })

  it('RRULE сервера разбирается обратно в пресет или «своё»', () => {
    expect(presetOf(parseRule('FREQ=WEEKLY;BYDAY=TH', 'Asia/Dushanbe'), '2026-09-24')).toBe(
      'weekly',
    )
    expect(presetOf(parseRule('FREQ=DAILY', 'Asia/Dushanbe'), '2026-09-24')).toBe('daily')
    expect(presetOf(parseRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TH', 'UTC'), '2026-09-24')).toBe(
      'custom',
    )
    expect(presetOf(null, '2026-09-24')).toBe('none')
  })

  it('UNTIL-момент сервера — дата в поясе пользователя; COUNT сохраняется', () => {
    // Душанбе — UTC+5: 18:59:59Z — ещё 31 декабря, 20:00Z — уже 1 января
    expect(parseRule('FREQ=DAILY;UNTIL=20261231T185959Z', 'Asia/Dushanbe')?.end).toEqual({
      kind: 'until',
      date: '2026-12-31',
    })
    expect(parseRule('FREQ=DAILY;UNTIL=20261231T200000Z', 'Asia/Dushanbe')?.end).toEqual({
      kind: 'until',
      date: '2027-01-01',
    })
    const counted = parseRule('RRULE:FREQ=MONTHLY;BYMONTHDAY=5;COUNT=10', 'UTC') as RepeatRule
    expect(counted.end).toEqual({ kind: 'count', count: 10 })
    expect(buildRule(counted)).toBe('FREQ=MONTHLY;BYMONTHDAY=5;COUNT=10')
    expect(parseRule('FREQ=HOURLY', 'UTC')).toBeNull()
  })

  it('понятная подпись правила по-русски', () => {
    expect(describe_(null)).toBe('Не повторять')
    expect(describe_(presetRule('daily', '2026-09-24'))).toBe('Каждый день')
    expect(describe_(presetRule('weekdays', '2026-09-24'))).toBe('По рабочим дням (пн–пт)')
    expect(describe_(presetRule('weekly', '2026-09-24'))).toBe('Каждую неделю: чт')
    expect(describe_(presetRule('monthlyNth', '2026-09-24'))).toBe('Каждый месяц, в последний чт')
    expect(
      describe_({
        freq: 'WEEKLY',
        interval: 2,
        byDay: ['WE', 'MO'],
        byMonthDay: null,
        end: { kind: 'count', count: 5 },
      }),
    ).toBe('Каждые 2 недели: пн, ср, 5 раз')
    expect(
      describe_({
        freq: 'MONTHLY',
        interval: 1,
        byDay: [],
        byMonthDay: 10,
        end: { kind: 'until', date: '2026-12-31' },
      }),
    ).toBe('Каждый месяц, 10-го числа до 31.12.2026')
  })
})
