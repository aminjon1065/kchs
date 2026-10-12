import type { PositionRejectReason } from '@kchs/contracts'

/** Часы устройства могут спешить: точку «из будущего» в пределах двух минут принимаем. */
export const MAX_FUTURE_MS = 2 * 60_000
/** Отложенная отправка с телефона без связи — до недели; старше — ошибка часов или повтор архива. */
export const MAX_AGE_MS = 7 * 24 * 3_600_000
/**
 * Быстрее не ездит и не летает ни одна единица сил Комитета (вертолёт — около
 * 300 км/ч): скорость между точками выше — скачок координат, а не движение.
 */
export const MAX_SPEED_KMH = 500

const EARTH_KM = 6371.0088

/** Расстояние по большому кругу, км. */
export function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

export interface CheckedPoint {
  index: number
  device: string
  /** Время фиксации, мс. */
  at: number
  lat: number
  lon: number
  speed: number | null
}

/**
 * Проверка времени и скорости пакета (ADR-0203). Точки устройства идут по
 * времени; опора каждой — ближайшая принятая точка раньше неё: из этого пакета
 * или последняя известная устройства. Скорость между опорой и точкой выше
 * `MAX_SPEED_KMH` — скачок, точка отбраковывается и опорой не становится.
 * Точка с тем же временем, что у опоры, — повтор: её решает база (ключ).
 */
export function checkPoints(
  points: readonly CheckedPoint[],
  previous: ReadonlyMap<string, { at: number; lat: number; lon: number }>,
  now: number,
): Map<number, PositionRejectReason> {
  const rejected = new Map<number, PositionRejectReason>()
  const byDevice = new Map<string, CheckedPoint[]>()
  for (const point of points) {
    if (point.at > now + MAX_FUTURE_MS) {
      rejected.set(point.index, 'future')
      continue
    }
    if (point.at < now - MAX_AGE_MS) {
      rejected.set(point.index, 'too_old')
      continue
    }
    if (point.speed !== null && point.speed > MAX_SPEED_KMH) {
      rejected.set(point.index, 'impossible_speed')
      continue
    }
    const list = byDevice.get(point.device) ?? []
    list.push(point)
    byDevice.set(point.device, list)
  }
  for (const [device, list] of byDevice) {
    list.sort((a, b) => a.at - b.at || a.index - b.index)
    const anchors: Array<{ at: number; lat: number; lon: number }> = []
    const last = previous.get(device)
    if (last) anchors.push(last)
    for (const point of list) {
      let anchor: { at: number; lat: number; lon: number } | null = null
      for (const candidate of anchors) {
        if (candidate.at < point.at && (!anchor || candidate.at > anchor.at)) anchor = candidate
      }
      if (anchor) {
        const hours = (point.at - anchor.at) / 3_600_000
        if (distanceKm(anchor, point) / hours > MAX_SPEED_KMH) {
          rejected.set(point.index, 'impossible_speed')
          continue
        }
      }
      anchors.push(point)
    }
  }
  return rejected
}
