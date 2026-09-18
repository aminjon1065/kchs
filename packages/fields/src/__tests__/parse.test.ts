import { describe, expect, it } from 'vitest'
import { formatDateTime } from '../format.js'
import {
  parseBoolean,
  parseDate,
  parseDateTime,
  parseInteger,
  parseNumber,
  parseTime,
  parseValue,
} from '../parse.js'

describe('parseNumber', () => {
  it('разделители тысяч любыми пробелами и десятичная запятая (ru)', () => {
    expect(parseNumber('12 345,6')).toBe(12345.6)
    expect(parseNumber('12 345,6')).toBe(12345.6)
    expect(parseNumber('12 345')).toBe(12345)
    expect(parseNumber("1'234'567")).toBe(1234567)
    expect(parseNumber('−12,5')).toBe(-12.5)
    expect(parseNumber('+5')).toBe(5)
  })

  it('запятая и точка вместе: десятичный знак — последний', () => {
    expect(parseNumber('1.234,56')).toBe(1234.56)
    expect(parseNumber('1,234.56')).toBe(1234.56)
    expect(parseNumber('1.234.567')).toBe(1234567)
    expect(parseNumber('1,234,567')).toBe(1234567)
  })

  it('одна запятая: ru — десятичная, en — тысячи при трёх цифрах', () => {
    expect(parseNumber('1,234', 'ru')).toBe(1.234)
    expect(parseNumber('1,234', 'en')).toBe(1234)
    expect(parseNumber('1,5', 'en')).toBe(1.5)
    expect(parseNumber('1.5', 'ru')).toBe(1.5)
  })

  it('не число — null', () => {
    expect(parseNumber('')).toBeNull()
    expect(parseNumber('abc')).toBeNull()
    expect(parseNumber('12,5 кг')).toBeNull()
    expect(parseNumber('1,2,3.4.5')).toBeNull()
  })

  it('целое — только целое', () => {
    expect(parseInteger('1 500')).toBe(1500)
    expect(parseInteger('1,5')).toBeNull()
  })
})

describe('parseBoolean', () => {
  it('да/нет на трёх языках и привычные обозначения', () => {
    for (const word of ['да', 'Да', 'true', '1', 'yes', 'ҳа', '✓'])
      expect(parseBoolean(word)).toBe(true)
    for (const word of ['нет', 'false', '0', 'no', 'не']) expect(parseBoolean(word)).toBe(false)
    expect(parseBoolean('может быть')).toBeNull()
  })
})

describe('parseDate', () => {
  it('день первым через точку, дефис и слэш (ru)', () => {
    expect(parseDate('01.02.2026')).toBe('2026-02-01')
    expect(parseDate('1.2.26')).toBe('2026-02-01')
    expect(parseDate('01-02-2026')).toBe('2026-02-01')
    expect(parseDate('01/02/2026', 'ru')).toBe('2026-02-01')
  })

  it('en: через слэш месяц первым; ISO — всегда', () => {
    expect(parseDate('01/02/2026', 'en')).toBe('2026-01-02')
    expect(parseDate('2026-02-01')).toBe('2026-02-01')
    expect(parseDate('2026-02-01T10:00:00Z')).toBe('2026-02-01')
  })

  it('несуществующие даты и мусор — null', () => {
    expect(parseDate('30.02.2026')).toBeNull()
    expect(parseDate('29.02.2025')).toBeNull()
    expect(parseDate('29.02.2024')).toBe('2024-02-29')
    expect(parseDate('13/13/2026', 'en')).toBeNull()
    expect(parseDate('01.02.2026 абв')).toBeNull()
    expect(parseDate('вчера')).toBeNull()
  })

  it('двузначный год: 00–69 — 2000-е, 70–99 — 1900-е', () => {
    expect(parseDate('01.01.69')).toBe('2069-01-01')
    expect(parseDate('01.01.70')).toBe('1970-01-01')
  })
})

describe('parseTime и parseDateTime', () => {
  it('время с секундами и без', () => {
    expect(parseTime('9:30')).toBe('09:30:00')
    expect(parseTime('23:59:59')).toBe('23:59:59')
    expect(parseTime('24:00')).toBeNull()
    expect(parseTime('2:30 PM')).toBe('14:30:00')
    expect(parseTime('12:05 am')).toBe('00:05:00')
    expect(parseTime('13:00 PM')).toBeNull()
  })

  it('дата-время без смещения — в часовом поясе (Душанбе, +05:00)', () => {
    expect(parseDateTime('01.02.2026 14:30')).toBe('2026-02-01T09:30:00.000Z')
    expect(parseDateTime('01.02.2026', { timezone: 'UTC' })).toBe('2026-02-01T00:00:00.000Z')
  })

  it('как форматирует Intl: запятая перед временем, en — 12 часов', () => {
    const local = formatDateTime('2026-02-01T09:30:00.000Z', { timezone: 'Asia/Dushanbe' })
    expect(parseDateTime(local)).toBe('2026-02-01T09:30:00.000Z')
    const en = formatDateTime('2026-02-01T09:30:00.000Z', {
      locale: 'en',
      timezone: 'Asia/Dushanbe',
    })
    expect(parseDateTime(en, { locale: 'en' })).toBe('2026-02-01T09:30:00.000Z')
    expect(parseDate('01.02.2026, 14:30')).toBe('2026-02-01')
  })

  it('ISO со смещением берётся как есть', () => {
    expect(parseDateTime('2026-02-01T14:30:00+05:00')).toBe('2026-02-01T09:30:00.000Z')
    expect(parseDateTime('2026-02-01T14:30:00Z')).toBe('2026-02-01T14:30:00.000Z')
    expect(parseDateTime('01.02.2026 25:00')).toBeNull()
  })
})

describe('parseValue', () => {
  const status = {
    type: 'select' as const,
    options: [
      { value: 'open', label: { ru: 'Открыто', en: 'Open' } },
      { value: 'closed', label: { ru: 'Закрыто', en: 'Closed' } },
    ],
  }

  it('пустая строка очищает значение', () => {
    expect(parseValue('  ', { type: 'number' })).toEqual({ ok: true, value: null })
  })

  it('выбор — по значению или подписи на любом языке', () => {
    expect(parseValue('закрыто', status)).toEqual({ ok: true, value: 'closed' })
    expect(parseValue('Open', status)).toEqual({ ok: true, value: 'open' })
    expect(parseValue('unknown', status)).toEqual({ ok: false })
    expect(parseValue('Открыто; Закрыто', { ...status, type: 'multi_select' })).toEqual({
      ok: true,
      value: ['open', 'closed'],
    })
  })

  it('проценты: доля по умолчанию, проценты при scale=percent', () => {
    expect(parseValue('12,5%', { type: 'percent' })).toEqual({ ok: true, value: 0.125 })
    expect(parseValue('0,25', { type: 'percent' })).toEqual({ ok: true, value: 0.25 })
    expect(parseValue('12,5%', { type: 'percent', format: { scale: 'percent' } })).toEqual({
      ok: true,
      value: 12.5,
    })
  })

  it('типы по разбору, неразборчивое — отказ', () => {
    expect(parseValue('1 500', { type: 'integer' })).toEqual({ ok: true, value: 1500 })
    expect(parseValue('да', { type: 'boolean' })).toEqual({ ok: true, value: true })
    expect(parseValue('01.02.2026', { type: 'date' })).toEqual({ ok: true, value: '2026-02-01' })
    expect(parseValue('{"a":1}', { type: 'json' })).toEqual({ ok: true, value: { a: 1 } })
    expect(parseValue('{a', { type: 'json' })).toEqual({ ok: false })
    expect(parseValue('abc', { type: 'number' })).toEqual({ ok: false })
    expect(parseValue('x', { type: 'user' })).toEqual({ ok: false })
  })

  it('текст сохраняется как есть, переводы строк — \\n', () => {
    expect(parseValue('строка 1\r\nстрока 2', { type: 'text' })).toEqual({
      ok: true,
      value: 'строка 1\nстрока 2',
    })
  })
})
