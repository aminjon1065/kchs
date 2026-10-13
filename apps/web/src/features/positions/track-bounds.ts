import type { Bbox, PositionFix } from '@kchs/contracts'

/** Одна точка — рамка в сотую градуса (около километра), чтобы было куда приблизить. */
const PAD = 0.01

/** Охват точек трека; одна точка — с полями. */
export function trackBounds(points: ReadonlyArray<Pick<PositionFix, 'lat' | 'lon'>>): Bbox | null {
  if (points.length === 0) return null
  let minLon = Number.POSITIVE_INFINITY
  let minLat = Number.POSITIVE_INFINITY
  let maxLon = Number.NEGATIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY
  for (const point of points) {
    minLon = Math.min(minLon, point.lon)
    maxLon = Math.max(maxLon, point.lon)
    minLat = Math.min(minLat, point.lat)
    maxLat = Math.max(maxLat, point.lat)
  }
  if (maxLon - minLon < PAD && maxLat - minLat < PAD) {
    return [minLon - PAD, minLat - PAD, maxLon + PAD, maxLat + PAD]
  }
  return [minLon, minLat, maxLon, maxLat]
}
