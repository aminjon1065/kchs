import type { FieldDef } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { columnTotals, validateRows, withNewRow } from './form-table.js'

const field = (key: string, type: FieldDef['type'], required = false): FieldDef => ({
  key,
  label: { ru: key },
  type,
  semantic: 'dimension',
  required,
  unique: false,
  indexed: false,
  sensitive: false,
  readOnly: false,
  nullable: true,
  order: 0,
})

const fields = [field('kind', 'text', true), field('injured', 'integer'), field('damage', 'money')]
const messages = { required: 'обязательное', invalid: 'некорректно' }

describe('табличная сводка на экране заполнения', () => {
  it('приводит значения к типам и пропускает корректные строки', () => {
    const result = validateRows(fields, [{ kind: 'Пожар', injured: '2' }], messages)
    expect(result).toEqual({ ok: true, rows: [{ kind: 'Пожар', injured: 2 }] })
  })

  it('отмечает ячейку без обязательного значения и пустую строку', () => {
    const result = validateRows(fields, [{ injured: 1 }, { kind: '', injured: null }], messages)
    expect(result).toEqual({
      ok: false,
      errors: { '0:kind': 'обязательное' },
      rowErrors: [1],
    })
  })

  it('отмечает некорректное число', () => {
    const result = validateRows(fields, [{ kind: 'ДТП', injured: 'два' }], messages)
    expect(result).toMatchObject({ ok: false, errors: { '0:injured': 'некорректно' } })
  })

  it('«Итого» — суммы числовых столбцов, текст не суммируется', () => {
    const rows = [
      { kind: 'Пожар', injured: 2, damage: '1500.5' },
      { kind: 'ДТП', injured: '1', damage: null },
    ]
    expect(columnTotals(fields, rows)).toEqual([null, 3, 1500.5])
  })

  it('строка добавляется только в пределах формы', () => {
    expect(withNewRow([{ kind: 'А' }], 3)).toEqual([{ kind: 'А' }, {}])
    expect(withNewRow([{ kind: 'А' }], 1)).toEqual([{ kind: 'А' }])
  })
})
