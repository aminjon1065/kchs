import { describe, expect, it } from 'vitest'
import { trackBounds } from './track-bounds.js'

describe('охват трека на карте', () => {
  it('рамка по крайним точкам; одна точка — с полями; пусто — нет рамки', () => {
    expect(
      trackBounds([
        { lat: 38.55, lon: 68.77 },
        { lat: 38.6, lon: 68.9 },
        { lat: 38.52, lon: 68.8 },
      ]),
    ).toEqual([68.77, 38.52, 68.9, 38.6])
    const single = trackBounds([{ lat: 38.5, lon: 68.7 }])
    expect(single?.[0]).toBeCloseTo(68.69)
    expect(single?.[3]).toBeCloseTo(38.51)
    expect(trackBounds([])).toBeNull()
  })
})
