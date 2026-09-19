import { describe, expect, it } from 'vitest'
import { atLeast, geometryBounds, unionBounds } from './geometry.js'
import { areaValue, distanceValue, lineLength, polygonMeasure, ring } from './measure.js'

describe('измерения на сфере', () => {
  it('длина ломаной: Душанбе — Худжанд около 204 км', () => {
    const meters = lineLength([
      [68.78, 38.56],
      [69.62, 40.28],
    ])
    expect(meters).toBeGreaterThan(203_000)
    expect(meters).toBeLessThan(206_000)
    expect(lineLength([[68.78, 38.56]])).toBe(0)
  })

  it('площадь и периметр: градус на экваторе ≈ 12 390 км², кольцо замыкается', () => {
    const square: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]
    expect(ring(square)).toHaveLength(5)
    const { area, perimeter } = polygonMeasure(square)
    expect(area / 1e6).toBeGreaterThan(12_300)
    expect(area / 1e6).toBeLessThan(12_450)
    expect(perimeter / 1000).toBeGreaterThan(440)
    expect(perimeter / 1000).toBeLessThan(450)
    expect(polygonMeasure(square.slice(0, 2)).area).toBe(0)
  })

  it('единицы: метры, километры, м², гектары, км²', () => {
    expect(distanceValue(7.25)).toEqual({ value: 7.25, unit: 'm', precision: 1 })
    expect(distanceValue(850)).toEqual({ value: 850, unit: 'm', precision: 0 })
    expect(distanceValue(12_340)).toEqual({ value: 12.34, unit: 'km', precision: 1 })
    expect(distanceValue(1500)).toEqual({ value: 1.5, unit: 'km', precision: 2 })
    expect(areaValue(4500)).toEqual({ value: 4500, unit: 'm2', precision: 0 })
    expect(areaValue(35_000)).toEqual({ value: 3.5, unit: 'ha', precision: 2 })
    expect(areaValue(3_200_000)).toEqual({ value: 3.2, unit: 'km2', precision: 2 })
  })
})

describe('охваты геометрий', () => {
  it('точка, полигон, мультигеометрия и Feature', () => {
    expect(geometryBounds({ type: 'Point', coordinates: [68.78, 38.56] })).toEqual([
      68.78, 38.56, 68.78, 38.56,
    ])
    expect(
      geometryBounds({
        type: 'Feature',
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [69, 38],
                [70, 38],
                [70, 39],
                [69, 38],
              ],
            ],
            [
              [
                [71, 37],
                [71.5, 37],
                [71.5, 37.5],
                [71, 37],
              ],
            ],
          ],
        },
      }),
    ).toEqual([69, 37, 71.5, 39])
    expect(geometryBounds(null)).toBeNull()
    expect(geometryBounds({ type: 'Point', coordinates: [] })).toBeNull()
  })

  it('объединение и минимальный размер охвата', () => {
    expect(unionBounds([null, [1, 1, 2, 2], [0, 1.5, 1.5, 3]])).toEqual([0, 1, 2, 3])
    expect(unionBounds([])).toBeNull()
    const padded = atLeast([68.78, 38.56, 68.78, 38.56], 0.01)
    expect(padded[2] - padded[0]).toBeCloseTo(0.01, 9)
    expect(atLeast([60, 30, 70, 40])).toEqual([60, 30, 70, 40])
  })
})
