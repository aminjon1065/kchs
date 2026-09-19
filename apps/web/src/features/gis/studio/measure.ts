import { area } from '@turf/area'
import { length } from '@turf/length'

/**
 * Измерения на карте (07-gis-engine.md §10, ADR-0073): расстояние по ломаной и
 * площадь многоугольника на сфере (turf: гаверсинус и сферический избыток) —
 * без искажений проекции Меркатора, которые на широте Таджикистана дают +28 %.
 */

export type Position = [number, number]

/** Длина ломаной, м. */
export function lineLength(points: readonly Position[]): number {
  if (points.length < 2) return 0
  return (
    length(
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: points.map((p) => [...p]) },
      },
      { units: 'kilometers' },
    ) * 1000
  )
}

/** Кольцо многоугольника: замкнуто первой точкой. */
export function ring(points: readonly Position[]): Position[] {
  const first = points[0]
  return first ? [...points, first] : []
}

/** Площадь (м²) и периметр (м) многоугольника по вершинам; меньше трёх — нули. */
export function polygonMeasure(points: readonly Position[]): { area: number; perimeter: number } {
  if (points.length < 3) return { area: 0, perimeter: lineLength(points) }
  const closed = ring(points)
  return {
    area: area({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [closed.map((p) => [...p])] },
    }),
    perimeter: lineLength(closed),
  }
}

export type MeasureUnit = 'm' | 'km' | 'm2' | 'ha' | 'km2'

export interface MeasureValue {
  value: number
  unit: MeasureUnit
  /** Знаков после запятой при выводе. */
  precision: number
}

/** Расстояние в удобных единицах: до километра — метры, дальше — километры. */
export function distanceValue(meters: number): MeasureValue {
  if (meters < 1000) return { value: meters, unit: 'm', precision: meters < 10 ? 1 : 0 }
  const km = meters / 1000
  return { value: km, unit: 'km', precision: km < 10 ? 2 : km < 100 ? 1 : 0 }
}

/** Площадь: до гектара — м², до 100 га — гектары, дальше — км². */
export function areaValue(squareMeters: number): MeasureValue {
  if (squareMeters < 10_000) return { value: squareMeters, unit: 'm2', precision: 0 }
  if (squareMeters < 1_000_000) {
    const ha = squareMeters / 10_000
    return { value: ha, unit: 'ha', precision: ha < 10 ? 2 : 1 }
  }
  const km2 = squareMeters / 1_000_000
  return { value: km2, unit: 'km2', precision: km2 < 10 ? 2 : km2 < 100 ? 1 : 0 }
}
