import type { FieldDef } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  formatDate,
  formatDuration,
  formatFileSize,
  formatNumber,
  formatPercent,
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
