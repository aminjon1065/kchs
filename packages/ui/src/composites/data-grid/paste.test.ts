import { createTranslator } from '@kchs/i18n'
import { describe, expect, it } from 'vitest'
import type { CellChange } from './history.js'
import type { RenderColumn } from './layout.js'
import { MAX_BATCH, pasteChanges, pasteReport, rowsToAppend } from './paste.js'
import { selectionSummary } from './summary.js'
import type { DataGridColumn, DataGridRow } from './types.js'
import { sameValue } from './values.js'

/** Разбор вставки и сводка по выделению — чистые функции таблицы данных. */
const ctx = { locale: 'ru' as const }

function column(key: string, type: DataGridColumn['type'], editable = true): RenderColumn {
  return {
    key,
    index: 0,
    column: { key, label: key === 'name' ? 'Название' : 'Число', type, editable },
    width: 120,
    left: 0,
    pinned: false,
    lastPinned: false,
    numeric: type === 'integer' || type === 'decimal',
    editor: editable ? (type === 'text' ? 'text' : 'number') : null,
  }
}

const columns = [column('name', 'text'), column('count', 'integer'), column('note', 'text', false)]
const rows: DataGridRow[] = [
  { id: 'r0', values: { name: 'Вахш', count: 1, note: null } },
  { id: 'r1', values: { name: 'Пяндж', count: 2, note: null } },
]
const getRow = (index: number) => rows[index]
const changeFor = (rowIndex: number, col: RenderColumn, value: unknown): CellChange | null => {
  const row = rows[rowIndex]
  if (!row) return null
  const previous = row.values[col.key]
  return sameValue(previous, value)
    ? null
    : { rowId: row.id, rowIndex, key: col.key, previous, value }
}

describe('pasteChanges', () => {
  it('правимые ячейки загруженных строк — изменения, равные текущему — без изменения', () => {
    const plan = pasteChanges(
      [
        { row: 0, col: 0, text: 'Вахш' },
        { row: 0, col: 1, text: '5' },
        { row: 1, col: 1, text: 'много' },
        { row: 1, col: 2, text: 'заметка' },
        { row: 7, col: 0, text: 'нет строки' },
      ],
      columns,
      getRow,
      changeFor,
      ctx,
    )
    expect(plan.changes).toEqual([
      { rowId: 'r0', rowIndex: 0, key: 'count', previous: 1, value: 5 },
    ])
    expect(plan).toMatchObject({ unchanged: 1, skipped: 2, overflow: 0 })
    expect(plan.invalid).toEqual([{ text: 'много', col: columns[1], rowId: 'r1' }])
  })

  it('сверх MAX_BATCH изменения не берутся, а считаются', () => {
    const many = Array.from({ length: MAX_BATCH + 2 }, (_, index) => ({
      row: 0,
      col: 1,
      text: String(index + 10),
    }))
    const plan = pasteChanges(many, columns, getRow, changeFor, ctx)
    expect(plan.changes).toHaveLength(MAX_BATCH)
    expect(plan.overflow).toBe(2)
  })
})

describe('pasteReport', () => {
  const t = createTranslator('ru')
  it('отчёт с нераспознанными — тон ошибки, без них — сведения', () => {
    const plan = pasteChanges([{ row: 1, col: 1, text: 'много' }], columns, getRow, changeFor, ctx)
    expect(pasteReport(t, plan, 1, 0).tone).toBe('danger')
    const clean = pasteChanges([{ row: 1, col: 1, text: '3' }], columns, getRow, changeFor, ctx)
    expect(pasteReport(t, clean, 1, 2)).toMatchObject({ tone: 'info' })
  })
})

describe('rowsToAppend', () => {
  it('строка заголовков отбрасывается, пустые и только для чтения — пропускаются', () => {
    const result = rowsToAppend(
      [
        ['Название', 'Число'],
        ['Кафирниган', '4', 'заметка'],
        ['', ''],
      ],
      0,
      columns,
      ctx,
    )
    expect(result).toEqual({ rows: [{ name: 'Кафирниган', count: 4 }], overflow: 0, invalid: null })
  })

  it('первое нераспознанное значение останавливает добавление', () => {
    const result = rowsToAppend([['Зеравшан', 'много']], 0, columns, ctx)
    expect(result.invalid).toMatchObject({ row: 0, text: 'много', col: { key: 'count' } })
  })
})

describe('selectionSummary', () => {
  it('сумма и среднее по числовым столбцам выделения; одна ячейка — без сводки', () => {
    const range = { active: { row: 0, col: 0 }, anchor: { row: 1, col: 1 }, rows: null }
    const summary = selectionSummary(range, { rows: 2, cols: 3 }, columns, getRow, new Map())
    expect(summary).toMatchObject({ cells: 4, sum: 3, avg: 1.5, partial: false })
    const single = { active: { row: 0, col: 1 }, anchor: { row: 0, col: 1 }, rows: null }
    expect(selectionSummary(single, { rows: 2, cols: 3 }, columns, getRow, new Map())).toBeNull()
  })
})
