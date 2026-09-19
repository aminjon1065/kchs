import { describe, expect, it } from 'vitest'
import { layoutLanes, layoutRows, snapMinutes } from './layout.js'

describe('раскладка сетки времени', () => {
  it('непересекающиеся события — по одной дорожке', () => {
    const boxes = layoutLanes([
      { key: 'a', start: 540, end: 600 },
      { key: 'b', start: 600, end: 660 },
    ])
    expect(boxes.get('a')).toEqual({ key: 'a', lane: 0, lanes: 1 })
    expect(boxes.get('b')).toEqual({ key: 'b', lane: 0, lanes: 1 })
  })

  it('пересечения делят ширину, свободная дорожка переиспользуется', () => {
    const boxes = layoutLanes([
      { key: 'a', start: 540, end: 660 },
      { key: 'b', start: 570, end: 600 },
      { key: 'c', start: 610, end: 640 },
      { key: 'd', start: 700, end: 720 },
    ])
    expect(boxes.get('a')).toEqual({ key: 'a', lane: 0, lanes: 2 })
    expect(boxes.get('b')).toEqual({ key: 'b', lane: 1, lanes: 2 })
    expect(boxes.get('c')).toEqual({ key: 'c', lane: 1, lanes: 2 })
    expect(boxes.get('d')).toEqual({ key: 'd', lane: 0, lanes: 1 })
  })

  it('три одновременных события — три дорожки', () => {
    const boxes = layoutLanes([
      { key: 'a', start: 600, end: 660 },
      { key: 'b', start: 600, end: 660 },
      { key: 'c', start: 630, end: 690 },
    ])
    expect([...boxes.values()].map((box) => box.lanes)).toEqual([3, 3, 3])
    expect(new Set([...boxes.values()].map((box) => box.lane)).size).toBe(3)
  })

  it('события на весь день раскладываются по полосам без наложений', () => {
    const rows = layoutRows([
      { key: 'week', first: 0, last: 4 },
      { key: 'mon', first: 0, last: 0 },
      { key: 'fri', first: 4, last: 6 },
      { key: 'sat', first: 5, last: 5 },
    ])
    expect(rows.get('week')).toBe(0)
    expect(rows.get('mon')).toBe(1)
    expect(rows.get('fri')).toBe(1)
    expect(rows.get('sat')).toBe(0)
  })

  it('привязка к шагу', () => {
    expect(snapMinutes(607, 15)).toBe(600)
    expect(snapMinutes(608, 15)).toBe(615)
  })
})
