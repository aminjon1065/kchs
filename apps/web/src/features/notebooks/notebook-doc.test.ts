import { NOTEBOOK_DOC } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { metricPeriod, sqlParams } from './cell-run.js'
import {
  applyTextChange,
  cellIds,
  cellsOf,
  createCell,
  duplicateCell,
  insertCell,
  moveCell,
  orderOf,
  paramsOf,
  readParams,
  removeCell,
} from './notebook-doc.js'

describe('документ тетради на клиенте', () => {
  it('новая ячейка — значения по умолчанию из контракта, текст — фрагмент Yjs', () => {
    const doc = new Y.Doc()
    const query = createCell('query')
    const text = createCell('text')
    insertCell(doc, text, 0)
    insertCell(doc, query, 1)
    const map = cellsOf(doc).get(query.id)
    expect(map?.get('kind')).toBe('query')
    expect(map?.get('mode')).toBe('visual')
    expect(map?.get('plan')).toEqual({
      filter: null,
      groups: [],
      measures: [{ agg: 'count' }],
      sort: null,
      limit: null,
    })
    expect(map?.get('sql')).toBeInstanceOf(Y.Text)
    expect(cellsOf(doc).get(text.id)?.get('body')).toBeInstanceOf(Y.XmlFragment)
    expect(cellIds(doc)).toEqual([text.id, query.id])
    expect(query.id).toMatch(/^c_[a-z0-9]+$/)
  })

  it('перенос, копия и удаление меняют порядок; содержимое копии — своё', () => {
    const doc = new Y.Doc()
    const [a, b, c] = [createCell('text'), createCell('metric'), createCell('ai')]
    for (const [index, cell] of [a, b, c].entries()) insertCell(doc, cell, index)
    moveCell(doc, a.id, 1)
    expect(cellIds(doc)).toEqual([b.id, a.id, c.id])
    moveCell(doc, c.id, -1)
    expect(cellIds(doc)).toEqual([b.id, c.id, a.id])
    const copy = duplicateCell(doc, c.id)
    expect(cellIds(doc)).toEqual([b.id, c.id, copy, a.id])
    cellsOf(doc).get(c.id)?.set('question', 'исходный')
    expect(
      cellsOf(doc)
        .get(copy as string)
        ?.get('question'),
    ).toBe('')
    removeCell(doc, b.id)
    expect(cellIds(doc)).toEqual([c.id, copy, a.id])
    expect(cellsOf(doc).has(b.id)).toBe(false)
  })

  it('одновременный перенос одной ячейки двумя авторами — ячейка одна', () => {
    const left = new Y.Doc()
    const [a, b, c] = [createCell('text'), createCell('text'), createCell('text')]
    for (const [index, cell] of [a, b, c].entries()) insertCell(left, cell, index)
    const right = new Y.Doc()
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
    moveCell(left, c.id, -1)
    moveCell(right, c.id, -1)
    moveCell(right, c.id, -1)
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right))
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
    expect(cellIds(left)).toHaveLength(3)
    expect(cellIds(left)).toEqual(cellIds(right))
    expect(orderOf(left).length).toBeGreaterThanOrEqual(3)
  })

  it('SQL: правка по разнице сохраняет одновременную правку соавтора', () => {
    const left = new Y.Doc()
    const cell = createCell('query', { mode: 'sql', sql: 'SELECT 1 FROM t' })
    insertCell(left, cell, 0)
    const right = new Y.Doc()
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
    const mine = cellsOf(left).get(cell.id)?.get('sql') as Y.Text
    const theirs = cellsOf(right).get(cell.id)?.get('sql') as Y.Text
    // Соавторы правят разные концы строки, не видя правок друг друга
    applyTextChange(mine, 'SELECT 1 FROM t WHERE x')
    applyTextChange(theirs, 'SELECT 2 FROM t')
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right))
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
    expect(mine.toString()).toBe('SELECT 2 FROM t WHERE x')
    expect(theirs.toString()).toBe(mine.toString())
  })

  it('параметры: значение вне контракта — «не задан»', () => {
    const doc = new Y.Doc()
    doc.transact(() => {
      paramsOf(doc).set('period', { unit: 'month', from: 0, to: 0 })
      paramsOf(doc).set('territory', 'не объект')
    })
    expect(readParams(doc)).toEqual({ period: { unit: 'month', from: 0, to: 0 }, territory: null })
    expect(doc.getMap(NOTEBOOK_DOC.params).size).toBe(2)
  })

  it('параметры для SQL и показателя: моменты в поясе пользователя, интервал дат — как даты', () => {
    const empty = sqlParams({ period: null, territory: null }, 'Asia/Dushanbe')
    expect(empty).toEqual({ period_from: null, period_to: null, territory: null })
    const dates = sqlParams(
      {
        period: { from: '2026-09-01', to: '2026-09-30' },
        territory: { id: 'T1', includeChildren: true },
      },
      'Asia/Dushanbe',
    )
    // Душанбе — UTC+5: полночь 1 сентября — 19:00 31 августа по UTC, конец — 1 октября
    expect(dates).toEqual({
      period_from: '2026-08-31T19:00:00.000Z',
      period_to: '2026-09-30T19:00:00.000Z',
      territory: 'T1',
    })
    expect(
      metricPeriod({ period: { from: '2026-09-01', to: '2026-09-30' }, territory: null }),
    ).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(metricPeriod({ period: null, territory: null })).toBeUndefined()
  })
})
