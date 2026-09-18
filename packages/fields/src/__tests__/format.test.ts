import type { FieldDef } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  formatCompactNumber,
  formatDate,
  formatDuration,
  formatFileSize,
  formatNumber,
  formatPercent,
  formatPeriod,
  formatValue,
} from '../format.js'
import { needsValue, operatorsFor } from '../operators.js'
import { isVisible, validateValues } from '../validate.js'

const field = (over: Partial<FieldDef>): FieldDef =>
  ({
    key: 'f',
    label: { ru: 'Поле' },
    type: 'text',
    semantic: 'dimension',
    required: false,
    unique: false,
    indexed: false,
    sensitive: false,
    readOnly: false,
    nullable: true,
    order: 0,
    ...over,
  }) as FieldDef

describe('форматирование', () => {
  it('числа в ru используют неразрывные разделители и запятую', () => {
    const result = formatNumber(1234567.89, { precision: 2 }, { locale: 'ru' })
    expect(result).toMatch(/1.234.567,89/)
  })

  it('числа в en используют точку', () => {
    expect(formatNumber(1234.5, { precision: 1 }, { locale: 'en' })).toBe('1,234.5')
  })

  it('проценты', () => {
    expect(formatPercent(0.256, { precision: 1 }, { locale: 'en' })).toBe('25.6%')
    expect(formatPercent(25.6, { precision: 1, scale: 'percent' }, { locale: 'en' })).toBe('25.6%')
  })

  it('дата в ru — дд.мм.гггг', () => {
    expect(formatDate('2026-09-17T08:00:00Z', { locale: 'ru', timezone: 'UTC' })).toBe('17.09.2026')
  })

  it('длительность', () => {
    expect(formatDuration(90, { locale: 'ru' })).toBe('1 ч 30 мин')
    expect(formatDuration(45, { locale: 'ru' })).toBe('45 мин')
    expect(formatDuration(120, { locale: 'en' })).toBe('2 h')
  })

  it('размер файла', () => {
    expect(formatFileSize(512, { locale: 'ru' })).toBe('512 Б')
    expect(formatFileSize(2 * 1024 * 1024, { locale: 'ru' })).toBe('2 МБ')
  })

  it('значение справочника показывает подпись', () => {
    const f = field({
      type: 'select',
      options: [{ value: 'high', label: { ru: 'Высокий', en: 'High' } }],
    })
    expect(formatValue('high', f, { locale: 'ru' })).toBe('Высокий')
    expect(formatValue('high', f, { locale: 'en' })).toBe('High')
    expect(formatValue('unknown', f, { locale: 'ru' })).toBe('unknown')
  })

  it('пустое значение — пустая строка', () => {
    expect(formatValue(null, field({}), {})).toBe('')
    expect(formatValue(undefined, field({}), {})).toBe('')
  })

  it('компактное число: до порога полностью, от порога сокращённо', () => {
    expect(formatCompactNumber(1284, { locale: 'ru' })).toMatch(/^1.284$/)
    expect(formatCompactNumber(12_900, { locale: 'ru' })).toMatch(/^12,9.тыс\.$/)
    expect(formatCompactNumber(4_200_000, { locale: 'en' })).toBe('4.2M')
    expect(formatCompactNumber(-15_000, { locale: 'en' })).toBe('-15K')
    expect(formatCompactNumber(15_000, { locale: 'en' }, { format: { suffix: ' t' } })).toBe(
      '15K t',
    )
  })

  it('период по бакету', () => {
    const ru = { locale: 'ru' as const, timezone: 'UTC' }
    expect(formatPeriod('2026-01-01', 'year', ru)).toBe('2026')
    expect(formatPeriod('2026-04-01', 'quarter', ru)).toBe('II кв. 2026')
    expect(formatPeriod('2026-04-01', 'quarter', ru, { compact: true })).toBe('II кв.')
    expect(formatPeriod('2026-04-01', 'quarter', { locale: 'en' })).toBe('Q2 2026')
    expect(formatPeriod('2026-01-01', 'month', ru)).toBe('янв. 2026')
    expect(formatPeriod('2026-01-01', 'month', ru, { compact: true })).toBe('янв.')
    expect(formatPeriod('2026-03-12', 'day', ru)).toBe('12.03.2026')
    expect(formatPeriod('2026-03-12', 'day', ru, { compact: true })).toBe('12.03')
    expect(formatPeriod('2026-03-12T14:00:00Z', 'hour', ru)).toBe('12.03, 14:00')
    expect(formatPeriod('2026-03-12T14:00:00Z', 'hour', ru, { compact: true })).toBe('14:00')
    expect(formatPeriod('2026-03-12T00:00:00Z', 'hour', { locale: 'en', timezone: 'UTC' })).toBe(
      '03/12, 00:00',
    )
  })

  it('календарная дата периода не сдвигается поясом', () => {
    const ctx = { locale: 'ru' as const, timezone: 'America/Los_Angeles' }
    expect(formatPeriod('2026-03-12', 'day', ctx)).toBe('12.03.2026')
    expect(formatPeriod('2026-01-01', 'year', ctx)).toBe('2026')
    expect(formatPeriod('not a date', 'day', ctx)).toBe('')
  })
})

describe('операторы фильтра', () => {
  it('для текста доступен contains, для чисел — between', () => {
    expect(operatorsFor('text')).toContain('contains')
    expect(operatorsFor('number')).toContain('between')
    expect(operatorsFor('territory')).toContain('within')
    expect(operatorsFor('geometry')).toContain('intersects')
  })

  it('операторы пустоты не требуют значения', () => {
    expect(needsValue('is_empty')).toBe(false)
    expect(needsValue('is_me')).toBe(false)
    expect(needsValue('eq')).toBe(true)
  })
})

describe('валидация значений', () => {
  it('обязательное поле требуется', () => {
    const result = validateValues([field({ key: 'name', required: true })], {})
    expect(result.ok).toBe(false)
  })

  it('диапазон числа проверяется', () => {
    const f = field({ key: 'n', type: 'number', validation: { min: 0, max: 100 } })
    expect(validateValues([f], { n: 50 }).ok).toBe(true)
    expect(validateValues([f], { n: 150 }).ok).toBe(false)
  })

  it('условная видимость исключает поле из проверки', () => {
    const f = field({
      key: 'reason',
      required: true,
      visibleIf: { field: 'kind', op: 'eq', value: 'incoming' },
    })
    expect(isVisible(f, { kind: 'outgoing' })).toBe(false)
    expect(validateValues([f], { kind: 'outgoing' }).ok).toBe(true)
    expect(validateValues([f], { kind: 'incoming' }).ok).toBe(false)
  })
})
