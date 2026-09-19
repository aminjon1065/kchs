import type { Bbox } from '@kchs/contracts'

/**
 * Охваты геометрий GeoJSON — «приблизить к выделенным», переход к найденному
 * объекту: обход координат без библиотек, геометрия приходит строкой датасета.
 */

/** Охват геометрии GeoJSON (объект геометрии или Feature); без координат — null. */
export function geometryBounds(geometry: unknown): Bbox | null {
  let west = Number.POSITIVE_INFINITY
  let south = Number.POSITIVE_INFINITY
  let east = Number.NEGATIVE_INFINITY
  let north = Number.NEGATIVE_INFINITY
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      const [lon, lat] = value as [number, number]
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return
      west = Math.min(west, lon)
      east = Math.max(east, lon)
      south = Math.min(south, lat)
      north = Math.max(north, lat)
      return
    }
    for (const item of value) visit(item)
  }
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    const record = node as Record<string, unknown>
    if (record.type === 'Feature') walk(record.geometry)
    else if (record.type === 'FeatureCollection' && Array.isArray(record.features)) {
      for (const feature of record.features) walk(feature)
    } else if (record.type === 'GeometryCollection' && Array.isArray(record.geometries)) {
      for (const item of record.geometries) walk(item)
    } else visit(record.coordinates)
  }
  walk(geometry)
  return Number.isFinite(west) ? [west, south, east, north] : null
}

/** Общий охват; пустой список — null. */
export function unionBounds(boxes: ReadonlyArray<Bbox | null | undefined>): Bbox | null {
  let out: Bbox | null = null
  for (const box of boxes) {
    if (!box) continue
    out = out
      ? [
          Math.min(out[0], box[0]),
          Math.min(out[1], box[1]),
          Math.max(out[2], box[2]),
          Math.max(out[3], box[3]),
        ]
      : box
  }
  return out
}

/**
 * Охват не меньше заданного размера в градусах: точка или короткий отрезок
 * не должны приближать карту до предельного зума.
 */
export function atLeast(box: Bbox, size = 0.005): Bbox {
  const [west, south, east, north] = box
  const padLon = Math.max(0, (size - (east - west)) / 2)
  const padLat = Math.max(0, (size - (north - south)) / 2)
  return [
    Math.max(-180, west - padLon),
    Math.max(-90, south - padLat),
    Math.min(180, east + padLon),
    Math.min(90, north + padLat),
  ]
}
