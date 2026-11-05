import type { DashboardTile } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  gridRows,
  moveTile,
  nextId,
  orderedTiles,
  packTiles,
  parseValues,
  periodValue,
  TV_MAX_ROW,
  TV_MIN_ROW,
  tvRowHeight,
} from './dashboard-layout.js'

const tile = (id: string, w: number, h: number, x = 0, y = 0): DashboardTile =>
  ({ id, kind: 'text', filterBindings: {}, x, y, w, h }) as DashboardTile

describe('раскладка дашборда', () => {
  it('упаковка по строкам без наложений', () => {
    const packed = packTiles([tile('a', 6, 4), tile('b', 6, 2), tile('c', 8, 3), tile('d', 4, 3)])
    expect(packed.map(({ id, x, y }) => [id, x, y])).toEqual([
      ['a', 0, 0],
      ['b', 6, 0],
      ['c', 0, 4],
      ['d', 8, 4],
    ])
  })

  it('порядок показа, сдвиг и новые идентификаторы', () => {
    const tiles = [tile('b', 6, 2, 6, 0), tile('c', 12, 3, 0, 4), tile('a', 6, 4, 0, 0)]
    expect(orderedTiles(tiles).map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(moveTile(orderedTiles(tiles), 2, -1).map((item) => item.id)).toEqual(['a', 'c', 'b'])
    expect(moveTile(tiles, 0, -1)).toEqual(tiles)
    expect(nextId('t', ['t1', 't2', 't4'])).toBe('t5')
  })

  it('значения фильтров: период и список', () => {
    expect(periodValue('all')).toBeNull()
    expect(periodValue('year')).toEqual({ unit: 'year', from: 0, to: 0 })
    expect(periodValue('last30')).toEqual({ unit: 'day', from: -29, to: 0 })
    expect(parseValues(' Хатлон, Согд ,,')).toEqual(['Хатлон', 'Согд'])
  })
})

describe('сетка TV-режима (ADR-0230)', () => {
  it('строк — по нижнему краю самой низкой плитки', () => {
    expect(gridRows([tile('a', 6, 2, 0, 0), tile('b', 6, 7, 6, 2), tile('c', 12, 3, 0, 9)])).toBe(
      12,
    )
    expect(gridRows([])).toBe(0)
  })

  it('высота строки делит экран поровну и не выходит за пределы', () => {
    // 17 строк ситуационного экрана в области 1920×1080 — около 44 px
    expect(tvRowHeight(1000, 17, 16)).toBe(Math.floor((1000 - 16 * 16) / 17))
    expect(tvRowHeight(600, 17, 16)).toBe(TV_MIN_ROW)
    expect(tvRowHeight(4000, 4, 16)).toBe(TV_MAX_ROW)
    expect(tvRowHeight(0, 17, 16)).toBe(TV_MAX_ROW)
  })
})
