import type { DashboardTile } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  moveTile,
  nextId,
  orderedTiles,
  packTiles,
  parseValues,
  periodValue,
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
