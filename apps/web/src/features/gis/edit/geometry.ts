import type { Bbox, FeatureGeometry, LayerGeometryType } from '@kchs/contracts'

/**
 * Геометрия правки объектов слоя (ADR-0076): инструменты по типу слоя, части
 * составных геометрий, точка для авто-территории, ввод координат вручную.
 */

export type Position = [number, number]
export type DrawKind = 'point' | 'line' | 'polygon'

/** Одиночная часть: инструменты рисования работают с ними, составные — по частям. */
export type GeometryPart =
  | { type: 'Point'; coordinates: Position }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'Polygon'; coordinates: Position[][] }

/** Инструменты рисования, подходящие слою: смешанный слой — все. */
export function drawKindsFor(type: LayerGeometryType): DrawKind[] {
  return type === 'mixed' ? ['point', 'line', 'polygon'] : [type]
}

export function kindOf(type: string): DrawKind | null {
  if (type === 'Point' || type === 'MultiPoint') return 'point'
  if (type === 'LineString' || type === 'MultiLineString') return 'line'
  if (type === 'Polygon' || type === 'MultiPolygon') return 'polygon'
  return null
}

const xy = (position: readonly number[]): Position => [Number(position[0]), Number(position[1])]

/** Части геометрии: составная — по одной на часть, высота отбрасывается. */
export function splitParts(geometry: FeatureGeometry): GeometryPart[] {
  switch (geometry.type) {
    case 'Point':
      return [{ type: 'Point', coordinates: xy(geometry.coordinates) }]
    case 'MultiPoint':
      return geometry.coordinates.map((position) => ({ type: 'Point', coordinates: xy(position) }))
    case 'LineString':
      return [{ type: 'LineString', coordinates: geometry.coordinates.map(xy) }]
    case 'MultiLineString':
      return geometry.coordinates.map((line) => ({
        type: 'LineString',
        coordinates: line.map(xy),
      }))
    case 'Polygon':
      return [{ type: 'Polygon', coordinates: geometry.coordinates.map((ring) => ring.map(xy)) }]
    case 'MultiPolygon':
      return geometry.coordinates.map((polygon) => ({
        type: 'Polygon',
        coordinates: polygon.map((ring) => ring.map(xy)),
      }))
  }
}

/**
 * Части обратно в геометрию: одна часть — одиночная, если исходная не была
 * составной; части одного семейства — составная.
 */
export function mergeParts(parts: readonly GeometryPart[], multi: boolean): FeatureGeometry | null {
  const [first] = parts
  if (!first) return null
  if (parts.length === 1 && !multi) return first as FeatureGeometry
  const same = parts.filter((part) => part.type === first.type)
  switch (first.type) {
    case 'Point':
      return {
        type: 'MultiPoint',
        coordinates: same.map((part) => part.coordinates as Position),
      }
    case 'LineString':
      return {
        type: 'MultiLineString',
        coordinates: same.map((part) => part.coordinates as Position[]),
      }
    case 'Polygon':
      return {
        type: 'MultiPolygon',
        coordinates: same.map((part) => part.coordinates as Position[][]),
      }
  }
}

/** Площадь кольца со знаком (в градусах²): для выбора крупной части и центроида. */
function ringArea(ring: readonly Position[]): number {
  let sum = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i] as Position
    const [x2, y2] = ring[i + 1] as Position
    sum += x1 * y2 - x2 * y1
  }
  return sum / 2
}

/** Точка внутри кольца (луч по горизонтали). */
export function insideRing(point: Position, ring: readonly Position[]): boolean {
  const [x, y] = point
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as Position
    const [xj, yj] = ring[j] as Position
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function polygonPoint(rings: readonly Position[][]): Position | null {
  const outer = rings[0]
  if (!outer || outer.length < 4) return null
  const area = ringArea(outer)
  let cx = 0
  let cy = 0
  if (Math.abs(area) > 1e-12) {
    for (let i = 0; i < outer.length - 1; i++) {
      const [x1, y1] = outer[i] as Position
      const [x2, y2] = outer[i + 1] as Position
      const cross = x1 * y2 - x2 * y1
      cx += (x1 + x2) * cross
      cy += (y1 + y2) * cross
    }
    cx /= 6 * area
    cy /= 6 * area
  } else {
    ;[cx, cy] = outer[0] as Position
  }
  const inHole = rings.slice(1).some((hole) => insideRing([cx, cy], hole))
  if (insideRing([cx, cy], outer) && !inHole) return [cx, cy]
  // Центроид снаружи (подкова): середина первого отрезка горизонтали через него внутри контура
  const crossings: number[] = []
  for (let i = 0; i < outer.length - 1; i++) {
    const [x1, y1] = outer[i] as Position
    const [x2, y2] = outer[i + 1] as Position
    if (y1 > cy !== y2 > cy) crossings.push(x1 + ((cy - y1) * (x2 - x1)) / (y2 - y1))
  }
  crossings.sort((a, b) => a - b)
  const [left, right] = crossings
  return left !== undefined && right !== undefined ? [(left + right) / 2, cy] : (outer[0] ?? null)
}

/**
 * Точка объекта для авто-территории: точка — сама, линия — средняя вершина,
 * полигон — центроид или точка внутри контура; у составной — крупнейшая часть.
 */
export function representativePoint(geometry: FeatureGeometry | null): Position | null {
  if (!geometry) return null
  const parts = splitParts(geometry)
  let best: GeometryPart | undefined
  let bestSize = -1
  for (const part of parts) {
    const size =
      part.type === 'Polygon'
        ? Math.abs(ringArea(part.coordinates[0] ?? []))
        : part.type === 'LineString'
          ? part.coordinates.length
          : 0
    if (size > bestSize) {
      best = part
      bestSize = size
    }
  }
  if (!best) return null
  if (best.type === 'Point') return best.coordinates
  if (best.type === 'LineString') {
    return best.coordinates[Math.floor((best.coordinates.length - 1) / 2)] ?? null
  }
  return polygonPoint(best.coordinates)
}

/** Охват геометрии: для «Показать» и приближения к объекту. */
export function bboxOf(geometry: FeatureGeometry | null): Bbox | null {
  if (!geometry) return null
  let out: Bbox | null = null
  const add = ([x, y]: Position) => {
    out = out
      ? [Math.min(out[0], x), Math.min(out[1], y), Math.max(out[2], x), Math.max(out[3], y)]
      : [x, y, x, y]
  }
  for (const part of splitParts(geometry)) {
    if (part.type === 'Point') add(part.coordinates)
    else if (part.type === 'LineString') part.coordinates.forEach(add)
    else for (const ring of part.coordinates) ring.forEach(add)
  }
  return out
}

/** Одинаковые геометрии — с точностью до сантиметров (сервер округляет координаты). */
export function sameGeometry(a: FeatureGeometry | null, b: FeatureGeometry | null): boolean {
  const round = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(round)
      : typeof value === 'number'
        ? Math.round(value * 1e7) / 1e7
        : value
  const norm = (geometry: FeatureGeometry | null) =>
    geometry ? JSON.stringify([geometry.type, round(geometry.coordinates)]) : null
  return norm(a) === norm(b)
}

// ─── Ввод координат вручную ──────────────────────────────────────────────────

/** Ошибка разбора: номер строки (с 1) и ключ сообщения. */
export interface CoordinatesError {
  line: number
  reason: 'format' | 'lat' | 'lon' | 'count'
}

/**
 * Вершины из текста: по одной на строку, «широта, долгота» в десятичных градусах
 * (точка — разделитель дробной части; между числами — запятая, точка с запятой
 * или пробел). Пустые строки пропускаются.
 */
export function parseCoordinates(text: string): Position[] | CoordinatesError {
  const out: Position[] = []
  const lines = text.split('\n')
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split(/[\s,;]+/).filter(Boolean)
    const numbers = parts.map(Number)
    if (numbers.length !== 2 || numbers.some((n) => !Number.isFinite(n))) {
      return { line: index + 1, reason: 'format' }
    }
    const [lat, lon] = numbers as [number, number]
    if (lat < -90 || lat > 90) return { line: index + 1, reason: 'lat' }
    if (lon < -180 || lon > 180) return { line: index + 1, reason: 'lon' }
    out.push([lon, lat])
  }
  return out
}

/** Вершины в текст «широта, долгота» — для правки координат существующего объекта. */
export function formatCoordinates(positions: readonly Position[]): string {
  const round = (n: number) => Number(n.toFixed(7)).toString()
  return positions.map(([lon, lat]) => `${round(lat)}, ${round(lon)}`).join('\n')
}

/**
 * Вершины одиночной части для ручной правки; составную и полигон с дырами
 * вручную не правят — только на карте.
 */
export function editablePositions(geometry: FeatureGeometry | null): Position[] | null {
  if (!geometry) return []
  if (geometry.type === 'Point') return [xy(geometry.coordinates)]
  if (geometry.type === 'LineString') return geometry.coordinates.map(xy)
  if (geometry.type === 'Polygon' && geometry.coordinates.length === 1) {
    const ring = (geometry.coordinates[0] ?? []).map(xy)
    return ring.slice(0, -1)
  }
  return null
}

/** Геометрия из вершин: точка — одна, линия — от двух, полигон — от трёх (кольцо замыкается). */
export function buildGeometry(
  kind: DrawKind,
  positions: readonly Position[],
): FeatureGeometry | CoordinatesError {
  if (kind === 'point') {
    const [point] = positions
    if (positions.length !== 1 || !point) return { line: 0, reason: 'count' }
    return { type: 'Point', coordinates: point }
  }
  if (kind === 'line') {
    if (positions.length < 2) return { line: 0, reason: 'count' }
    return { type: 'LineString', coordinates: [...positions] }
  }
  const ring = [...positions]
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) ring.push(first)
  if (ring.length < 4) return { line: 0, reason: 'count' }
  return { type: 'Polygon', coordinates: [ring] }
}
