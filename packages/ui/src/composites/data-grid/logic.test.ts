import { describe, expect, it } from 'vitest'
import { parseTsv, pasteTargets, toTsv } from './clipboard.js'
import { reconcileColumnState } from './column-state.js'
import { dropChanges, EMPTY_HISTORY, planRedo, planUndo, recordEdit } from './history.js'
import { type CellOverlay, cellKey, cellValue, settleOverlay, withoutCells } from './overlay.js'
import {
  countRows,
  EMPTY_SELECTION,
  fitSelection,
  hasRow,
  isCellSelected,
  moveBy,
  moveToEdge,
  normalizeSpans,
  rangeOf,
  rowSelectionSpan,
  selectAll,
  selectCell,
  selectRow,
  tabMove,
} from './selection.js'
import { summarize } from './summary.js'
import { copyText, displayText, editorKind, editText, sameValue } from './values.js'

const bounds = { rows: 100, cols: 5 }

describe('выделение', () => {
  it('Shift расширяет диапазон от опорной ячейки', () => {
    let state = selectCell(EMPTY_SELECTION, { row: 2, col: 1 }, bounds)
    state = moveBy(state, 3, 2, bounds, true)
    expect(rangeOf(state)).toEqual({ top: 2, bottom: 5, left: 1, right: 3 })
    // Без Shift диапазон схлопывается к новой ячейке
    state = moveBy(state, 1, 0, bounds)
    expect(rangeOf(state)).toEqual({ top: 6, bottom: 6, left: 3, right: 3 })
  })

  it('движение не выходит за границы таблицы', () => {
    let state = selectCell(EMPTY_SELECTION, { row: 0, col: 0 }, bounds)
    state = moveBy(state, -5, -5, bounds)
    expect(state.active).toEqual({ row: 0, col: 0 })
    state = moveToEdge(state, 'gridEnd', bounds)
    expect(state.active).toEqual({ row: 99, col: 4 })
    state = moveToEdge(state, 'rowStart', bounds)
    expect(state.active).toEqual({ row: 99, col: 0 })
  })

  it('Tab идёт вправо и переносит на следующую строку', () => {
    let state = selectCell(EMPTY_SELECTION, { row: 0, col: 4 }, bounds)
    state = tabMove(state, false, bounds)
    expect(state.active).toEqual({ row: 1, col: 0 })
    state = tabMove(state, true, bounds)
    expect(state.active).toEqual({ row: 0, col: 4 })
    // С первой ячейки назад не уходит
    const first = selectCell(EMPTY_SELECTION, { row: 0, col: 0 }, bounds)
    expect(tabMove(first, true, bounds)).toBe(first)
  })

  it('строки: одна, подряд (Shift), выборочно (⌘)', () => {
    let state = selectRow(EMPTY_SELECTION, 10, bounds)
    state = selectRow(state, 14, bounds, 'extend')
    expect(state.rows).toEqual([[10, 14]])
    state = selectRow(state, 12, bounds, 'toggle')
    expect(state.rows).toEqual([
      [10, 11],
      [13, 14],
    ])
    state = selectRow(state, 20, bounds, 'toggle')
    expect(countRows(state.rows)).toBe(5)
    expect(hasRow(state.rows, 20)).toBe(true)
    expect(isCellSelected(state, 12, 0)).toBe(false)
    expect(rowSelectionSpan(state, 13, 5)).toEqual({ left: 0, right: 4 })
    // Shift заменяет отрезок от опорной строки, а не копит отрезки
    state = selectRow(state, 22, bounds, 'extend')
    expect(state.rows).toEqual([[20, 22]])
  })

  it('отрезки строк сливаются', () => {
    expect(
      normalizeSpans([
        [5, 7],
        [1, 2],
        [3, 4],
        [9, 9],
      ]),
    ).toEqual([
      [1, 7],
      [9, 9],
    ])
  })

  it('выделить всё', () => {
    expect(rangeOf(selectAll(bounds))).toEqual({ top: 0, bottom: 99, left: 0, right: 4 })
    expect(selectAll({ rows: 0, cols: 3 })).toEqual(EMPTY_SELECTION)
  })

  it('таблица уменьшилась — выделение сжимается до активной ячейки в границах', () => {
    const state = selectAll(bounds)
    expect(fitSelection(state, bounds)).toBe(state)
    expect(fitSelection(state, { rows: 10, cols: 5 })).toEqual({
      active: { row: 0, col: 0 },
      anchor: { row: 0, col: 0 },
      rows: null,
    })
    const rows = selectRow(EMPTY_SELECTION, 50, bounds)
    expect(fitSelection(rows, { rows: 40, cols: 5 }).rows).toBeNull()
    expect(fitSelection(state, { rows: 0, cols: 5 })).toEqual(EMPTY_SELECTION)
  })
})

describe('буфер обмена TSV', () => {
  it('туда и обратно с табуляцией, кавычками и переводом строки в ячейке', () => {
    const rows = [
      ['Район', 'Примечание'],
      ['Вахдат', 'строка 1\nстрока 2'],
      ['Рудаки', 'сказал "да"\tи ушёл'],
    ]
    expect(parseTsv(toTsv(rows))).toEqual(rows)
  })

  it('как из Excel: \\r\\n и завершающий перевод строки', () => {
    expect(parseTsv('a\tb\r\nc\td\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(parseTsv('одно значение')).toEqual([['одно значение']])
    expect(parseTsv('a\t\tc')).toEqual([['a', '', 'c']])
  })

  it('блок ложится с активной ячейки, лишнее отбрасывается', () => {
    const { targets, clipped } = pasteTargets(
      [
        ['1', '2'],
        ['3', '4'],
      ],
      { row: 99, col: 4 },
      null,
      bounds,
    )
    expect(targets).toEqual([{ row: 99, col: 4, text: '1' }])
    expect(clipped).toBe(3)
  })

  it('одно значение в выделенный диапазон — заполнение', () => {
    const { targets } = pasteTargets(
      [['x']],
      { row: 0, col: 0 },
      { top: 0, bottom: 1, left: 0, right: 1 },
      bounds,
    )
    expect(targets.map((target) => `${target.row}:${target.col}`)).toEqual([
      '0:0',
      '0:1',
      '1:0',
      '1:1',
    ])
  })
})

describe('отмена и повтор', () => {
  const change = (value: number) => ({
    rowId: '1',
    rowIndex: 0,
    key: 'amount',
    previous: value - 1,
    value,
  })

  it('отмена применяет обратный пакет, повтор — исходный', () => {
    let history = recordEdit(EMPTY_HISTORY, [change(1)])
    history = recordEdit(history, [change(2)])
    const undo = planUndo(history)
    expect(undo?.apply).toEqual([{ ...change(2), previous: 2, value: 1 }])
    history = undo?.next ?? history
    const redo = planRedo(history)
    expect(redo?.apply).toEqual([change(2)])
    expect(redo?.next.past).toHaveLength(2)
  })

  it('новая правка сбрасывает повтор; пустой пакет не записывается', () => {
    let history = recordEdit(EMPTY_HISTORY, [change(1)])
    history = planUndo(history)?.next ?? history
    expect(history.future).toHaveLength(1)
    history = recordEdit(history, [change(5)])
    expect(history.future).toHaveLength(0)
    expect(recordEdit(history, [])).toBe(history)
    expect(planUndo(EMPTY_HISTORY)).toBeNull()
  })

  it('отклонённые сервером изменения уходят из истории', () => {
    const accepted = change(1)
    const rejected = { ...change(2), rowId: '2' }
    const batch = [accepted, rejected]
    let history = recordEdit(EMPTY_HISTORY, batch)
    history = dropChanges(history, batch, new Set([rejected]))
    expect(history.past).toEqual([[accepted]])
    // Весь пакет отклонён — записи нет совсем
    const lone = [change(3)]
    expect(dropChanges(recordEdit(EMPTY_HISTORY, lone), lone, new Set(lone)).past).toHaveLength(0)
  })
})

describe('правки поверх данных', () => {
  const row = { id: 'r1', values: { amount: 10 } }
  const entry = (patch: Partial<CellOverlay>): CellOverlay => ({
    rowId: 'r1',
    rowIndex: 0,
    key: 'amount',
    value: 12,
    token: {},
    status: 'saved',
    generation: 0,
    ...patch,
  })

  it('ячейка показывает неподтверждённое значение', () => {
    const overlay = new Map([[cellKey('r1', 'amount'), entry({ status: 'pending' })]])
    expect(cellValue(row, 'amount', overlay)).toBe(12)
    expect(cellValue(row, 'amount', new Map())).toBe(10)
  })

  it('сохранённая правка снимается, когда данные её отразили', () => {
    const overlay = new Map([[cellKey('r1', 'amount'), entry({})]])
    // Данные ещё старые — правка держится одно обновление
    const stale = settleOverlay(overlay, () => row)
    expect(stale.get(cellKey('r1', 'amount'))?.generation).toBe(1)
    expect(settleOverlay(stale, () => row).size).toBe(0)
    // Данные обновились — правка больше не нужна
    expect(settleOverlay(overlay, () => ({ id: 'r1', values: { amount: 12 } })).size).toBe(0)
    // Неподтверждённая правка не трогается
    const pending = new Map([[cellKey('r1', 'amount'), entry({ status: 'pending' })]])
    expect(settleOverlay(pending, () => undefined)).toBe(pending)
  })

  it('ошибки ячеек снимаются новой правкой', () => {
    const errors = new Map([[cellKey('r1', 'amount'), 'Меньше нуля']])
    expect(withoutCells(errors, [{ rowId: 'r1', key: 'amount' }]).size).toBe(0)
    expect(withoutCells(errors, [{ rowId: 'r2', key: 'amount' }])).toBe(errors)
  })
})

describe('раскладка столбцов', () => {
  const columns = [
    { key: 'a', label: 'A', type: 'text' as const },
    { key: 'b', label: 'B', type: 'text' as const },
    { key: 'c', label: 'C', type: 'text' as const },
  ]

  it('новые столбцы — в конец порядка, удалённые — забываются', () => {
    expect(
      reconcileColumnState(columns, {
        order: ['c', 'x', 'a'],
        widths: { a: 100, x: 50 },
        hidden: ['x', 'b'],
        pinned: ['x'],
      }),
    ).toEqual({ order: ['c', 'a', 'b'], widths: { a: 100 }, hidden: ['b'], pinned: [] })
  })
})

describe('сводка и значения', () => {
  it('сумма и среднее по числам, пустые не считаются', () => {
    expect(summarize([1, 2, null, '3', ''], 5, true, false)).toEqual({
      cells: 5,
      filled: 3,
      sum: 6,
      avg: 2,
      partial: false,
    })
    expect(summarize(['a', null], 2, false, true)).toMatchObject({
      filled: 1,
      sum: null,
      partial: true,
    })
  })

  it('копирование сохраняет точность и десятичный знак локали', () => {
    const ctx = { locale: 'ru' as const, timezone: 'Asia/Dushanbe' }
    expect(copyText(1234.5678, { type: 'number' }, ctx)).toBe('1234,5678')
    expect(copyText(1234.5678, { type: 'number' }, { locale: 'en' })).toBe('1234.5678')
    expect(copyText('2026-02-01', { type: 'date' }, ctx)).toBe('01.02.2026')
    expect(copyText(true, { type: 'boolean' }, ctx)).toBe('Да')
    expect(editText(12.5, { type: 'number' }, ctx)).toBe('12,5')
  })

  it('показ по типу и вид правки', () => {
    const ctx = { locale: 'ru' as const }
    expect(displayText({ type: 'Point' }, { type: 'geometry' }, ctx)).toBe('{"type":"Point"}')
    expect(displayText('09:30:00', { type: 'time' }, ctx)).toBe('09:30')
    expect(editorKind('integer')).toBe('number')
    expect(editorKind('boolean')).toBe('boolean')
    expect(editorKind('select')).toBe('select')
    expect(editorKind('user')).toBeNull()
    expect(editorKind('geometry')).toBeNull()
    expect(editorKind('rollup')).toBeNull()
  })

  it('неизменённое значение не отправляется', () => {
    expect(sameValue(null, '')).toBe(true)
    expect(sameValue(undefined, null)).toBe(true)
    expect(sameValue(0, null)).toBe(false)
    expect(sameValue(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameValue('1', 1)).toBe(false)
  })
})
