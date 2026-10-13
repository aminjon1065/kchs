import { describe, expect, it } from 'vitest'
import {
  type Bbox,
  findChunk,
  fitMaxZoom,
  mergeRanges,
  tileCount,
  tileOf,
  tilesOf,
  totalBytes,
} from './pack-plan.js'

/** Варзобский район: около 60 × 80 км к северу от Душанбе. */
const VARZOB: Bbox = [68.55, 38.6, 69.15, 39.3]

describe('тайлы рамки', () => {
  it('номер тайла как у схемы XYZ', () => {
    expect(tileOf(0, 0, 0)).toEqual([0, 0])
    expect(tileOf(-180, 85, 1)).toEqual([0, 0])
    expect(tileOf(179.99, -85, 1)).toEqual([1, 1])
    // Душанбе на масштабе 10
    expect(tileOf(68.78, 38.56, 10)).toEqual([707, 392])
  })

  it('на каждом масштабе прямоугольник тайлов растёт вчетверо', () => {
    expect(tileCount(VARZOB, 0)).toBe(1)
    const z10 = tileCount(VARZOB, 10)
    const z12 = tileCount(VARZOB, 12)
    expect(z12).toBeGreaterThan(z10 * 4)
    expect([...tilesOf(VARZOB, 10, 10)]).toHaveLength(z10)
  })

  it('бюджет тайлов ограничивает наибольший масштаб', () => {
    expect(fitMaxZoom(VARZOB, 0, 14)).toBe(14)
    expect(fitMaxZoom(VARZOB, 0, 14, 300)).toBeLessThan(14)
    // Таджикистан целиком до улиц в бюджет не помещается
    expect(fitMaxZoom([67.3, 36.6, 75.2, 41.1], 0, 14)).toBeLessThan(14)
  })
})

describe('склейка диапазонов', () => {
  it('повторы и соседи через малый зазор — один кусок', () => {
    expect(
      mergeRanges([
        [100, 10],
        [0, 50],
        [100, 10],
        [60, 30],
      ]),
    ).toEqual([[0, 110]])
  })

  it('далёкие — отдельно, длинная склейка режется по размеру куска', () => {
    expect(
      mergeRanges(
        [
          [0, 10],
          [1000, 10],
        ],
        100,
      ),
    ).toEqual([
      [0, 10],
      [1000, 10],
    ])
    expect(
      mergeRanges(
        [
          [0, 60],
          [60, 60],
        ],
        0,
        100,
      ),
    ).toEqual([
      [0, 60],
      [60, 60],
    ])
  })

  it('кусок находится по любому диапазону внутри, а на стыке — нет', () => {
    const chunks = mergeRanges(
      [
        [0, 16_384],
        [100_000, 500],
        [100_600, 400],
        [900_000, 50],
      ],
      200,
    )
    expect(chunks).toEqual([
      [0, 16_384],
      [100_000, 1000],
      [900_000, 50],
    ])
    expect(totalBytes(chunks)).toBe(17_434)
    expect(findChunk(chunks, 127, 300)).toBe(0)
    expect(findChunk(chunks, 100_600, 400)).toBe(1)
    expect(findChunk(chunks, 900_010, 40)).toBe(2)
    expect(findChunk(chunks, 100_900, 200)).toBe(-1)
    expect(findChunk(chunks, 50_000, 10)).toBe(-1)
  })
})
