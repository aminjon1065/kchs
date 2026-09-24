import { describe, expect, it } from 'vitest'
import { checkTableRows, isBlank, pickFields } from './table-rows.js'

const definition = {
  fields: [
    { key: 'type', required: true, hint: null },
    { key: 'injured', required: false, hint: null },
  ],
  table: { minRows: 0, maxRows: 3 },
}

describe('строки табличной сводки', () => {
  it('оставляет только поля формы', () => {
    const result = checkTableRows(definition, [{ type: 'FIRE', injured: 2, extra: 'лишнее' }])
    expect(result).toEqual({ ok: true, rows: [{ type: 'FIRE', injured: 2 }] })
  })

  it('пустая таблица допустима, если форма разрешает ноль строк', () => {
    expect(checkTableRows(definition, [])).toEqual({ ok: true, rows: [] })
    const strict = { ...definition, table: { minRows: 1, maxRows: 3 } }
    expect(checkTableRows(strict, [])).toMatchObject({ ok: false })
  })

  it('больше строк, чем разрешено, — ошибка', () => {
    const rows = [{ type: 'A' }, { type: 'B' }, { type: 'C' }, { type: 'D' }]
    expect(checkTableRows(definition, rows)).toMatchObject({
      ok: false,
      message: expect.stringContaining('(3)'),
    })
  })

  it('обязательное поле проверяется в каждой строке с её номером', () => {
    const result = checkTableRows(definition, [{ type: 'FIRE' }, { injured: 1 }])
    expect(result).toEqual({ ok: false, message: 'Строка 2: поле «type» обязательно' })
  })

  it('полностью пустая строка — ошибка, а не молчаливый пропуск', () => {
    const result = checkTableRows(definition, [{ type: 'FIRE' }, { type: '  ', injured: null }])
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('Строка 2') })
  })

  it('пустое значение — не заполнено, ноль и false — заполнены', () => {
    expect(isBlank(undefined)).toBe(true)
    expect(isBlank(null)).toBe(true)
    expect(isBlank(' ')).toBe(true)
    expect(isBlank(0)).toBe(false)
    expect(isBlank(false)).toBe(false)
    expect(pickFields({ a: 1, b: 2 }, ['a', 'c'])).toEqual({ a: 1 })
  })
})
