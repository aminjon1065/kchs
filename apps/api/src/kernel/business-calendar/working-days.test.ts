import type { BusinessDayKind } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  countWorkingDays,
  endOfLocalDay,
  isWorkingDate,
  localDate,
  shiftWorkingDays,
  startOfLocalDay,
  weekday,
} from './working-days.js'

/** Навруз 2026: 21–24 марта (21-е — суббота), перенос выходного на 25-е и рабочая суббота 28-го. */
const NAVRUZ: Record<string, BusinessDayKind> = {
  '2026-03-21': 'holiday',
  '2026-03-22': 'holiday',
  '2026-03-23': 'holiday',
  '2026-03-24': 'holiday',
}
const kindOf = (days: Record<string, BusinessDayKind>) => (day: string) => days[day]

describe('рабочие дни по производственному календарю', () => {
  it('правило недели и исключения календаря', () => {
    expect(weekday('2026-03-20')).toBe(5)
    expect(isWorkingDate('2026-03-20', kindOf({}))).toBe(true)
    expect(isWorkingDate('2026-03-21', kindOf({}))).toBe(false)
    expect(isWorkingDate('2026-03-23', kindOf(NAVRUZ))).toBe(false)
    expect(isWorkingDate('2026-03-28', kindOf({ '2026-03-28': 'work' }))).toBe(true)
    expect(isWorkingDate('2026-03-27', kindOf({ '2026-03-27': 'short' }))).toBe(true)
    expect(isWorkingDate('2026-03-26', kindOf({ '2026-03-26': 'weekend' }))).toBe(false)
  })

  it('сдвиг вперёд перескакивает выходные и праздники', () => {
    // Пятница + 1 рабочий день: суббота–вторник — выходные и Навруз, срок — среда
    expect(shiftWorkingDays('2026-03-20', 1, kindOf(NAVRUZ))).toBe('2026-03-25')
    // Без календаря — понедельник
    expect(shiftWorkingDays('2026-03-20', 1, kindOf({}))).toBe('2026-03-23')
    expect(shiftWorkingDays('2026-03-20', 3, kindOf(NAVRUZ))).toBe('2026-03-27')
    // Рабочая суббота считается
    expect(shiftWorkingDays('2026-03-27', 1, kindOf({ '2026-03-28': 'work' }))).toBe('2026-03-28')
  })

  it('сдвиг назад — для напоминаний «за N рабочих дней до срока»', () => {
    expect(shiftWorkingDays('2026-03-25', -1, kindOf(NAVRUZ))).toBe('2026-03-20')
    expect(shiftWorkingDays('2026-03-30', -3, kindOf({}))).toBe('2026-03-25')
  })

  it('нулевой сдвиг — ближайший рабочий день', () => {
    expect(shiftWorkingDays('2026-03-20', 0, kindOf(NAVRUZ))).toBe('2026-03-20')
    expect(shiftWorkingDays('2026-03-21', 0, kindOf(NAVRUZ))).toBe('2026-03-25')
  })

  it('через границу года', () => {
    const newYear = kindOf({ '2027-01-01': 'holiday' })
    // Четверг 31 декабря 2026 + 1: пятница 1 января — праздник, дальше выходные
    expect(shiftWorkingDays('2026-12-31', 1, newYear)).toBe('2027-01-04')
  })

  it('число рабочих дней в промежутке', () => {
    expect(countWorkingDays('2026-03-20', '2026-03-27', kindOf(NAVRUZ))).toBe(3)
    expect(countWorkingDays('2026-03-27', '2026-03-20', kindOf(NAVRUZ))).toBe(-3)
    expect(countWorkingDays('2026-03-20', '2026-03-20', kindOf(NAVRUZ))).toBe(0)
  })

  it('конец и начало дня в поясе установки', () => {
    expect(endOfLocalDay('2026-03-25', 'Asia/Dushanbe').toISOString()).toBe(
      '2026-03-25T18:59:59.999Z',
    )
    expect(startOfLocalDay('2026-03-25', 'Asia/Dushanbe').toISOString()).toBe(
      '2026-03-24T19:00:00.000Z',
    )
    // 20:30 UTC 24 марта — уже 25-е по Душанбе
    expect(localDate(new Date('2026-03-24T20:30:00Z'), 'Asia/Dushanbe')).toBe('2026-03-25')
    // Летнее время: конец дня в Берлине летом — 21:59:59.999 UTC
    expect(endOfLocalDay('2026-07-01', 'Europe/Berlin').toISOString()).toBe(
      '2026-07-01T21:59:59.999Z',
    )
  })
})
