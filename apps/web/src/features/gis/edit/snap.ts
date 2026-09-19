import type { FeatureGeometry } from '@kchs/contracts'
import { type Position, splitParts } from './geometry.js'

/**
 * Привязка к вершинам и рёбрам объектов видимых слоёв (07-gis-engine.md §7,
 * ADR-0076): кандидаты — объекты слоёв в охвате карты, отбор — по рамке, затем
 * ближайшая вершина в пределах допуска в пикселях экрана, иначе ближайшая точка
 * на ребре. Проекция — у карты (пиксели контейнера).
 */

export interface SnapProjection {
  project: (lng: number, lat: number) => { x: number; y: number }
  unproject: (x: number, y: number) => { lng: number; lat: number }
}

interface Candidate {
  bbox: [number, number, number, number]
  /** Цепочки вершин: точка — из одной, кольцо — замкнутое. */
  paths: Position[][]
}

export interface SnapResult {
  position: Position
  kind: 'vertex' | 'edge'
}

function pathsOf(geometry: FeatureGeometry): Position[][] {
  const out: Position[][] = []
  for (const part of splitParts(geometry)) {
    if (part.type === 'Point') out.push([part.coordinates])
    else if (part.type === 'LineString') out.push(part.coordinates)
    else out.push(...part.coordinates)
  }
  return out
}

function bboxOfPaths(paths: Position[][]): Candidate['bbox'] {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const path of paths) {
    for (const [x, y] of path) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  return [minX, minY, maxX, maxY]
}

export class SnapIndex {
  private readonly candidates: Candidate[]

  constructor(geometries: ReadonlyArray<FeatureGeometry | null>) {
    this.candidates = geometries.flatMap((geometry) => {
      if (!geometry) return []
      const paths = pathsOf(geometry).filter((path) => path.length > 0)
      return paths.length > 0 ? [{ bbox: bboxOfPaths(paths), paths }] : []
    })
  }

  get size(): number {
    return this.candidates.length
  }

  /** Ближайшая вершина, иначе ближайшая точка на ребре — в пределах `tolerance` пикселей. */
  nearest(
    point: { x: number; y: number },
    projection: SnapProjection,
    tolerance: number,
  ): SnapResult | null {
    // Рамка допуска в градусах: отбор кандидатов без проекции каждой вершины
    const a = projection.unproject(point.x - tolerance, point.y - tolerance)
    const b = projection.unproject(point.x + tolerance, point.y + tolerance)
    const west = Math.min(a.lng, b.lng)
    const east = Math.max(a.lng, b.lng)
    const south = Math.min(a.lat, b.lat)
    const north = Math.max(a.lat, b.lat)
    const near = this.candidates.filter(
      ({ bbox }) => bbox[0] <= east && bbox[2] >= west && bbox[1] <= north && bbox[3] >= south,
    )
    if (near.length === 0) return null

    const limit = tolerance * tolerance
    let vertex: Position | null = null
    let vertexDistance = limit
    for (const { paths } of near) {
      for (const path of paths) {
        for (const position of path) {
          const [lng, lat] = position
          if (lng < west || lng > east || lat < south || lat > north) continue
          const p = projection.project(lng, lat)
          const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2
          if (d <= vertexDistance) {
            vertexDistance = d
            vertex = position
          }
        }
      }
    }
    if (vertex) return { position: [vertex[0], vertex[1]], kind: 'vertex' }

    let edge: Position | null = null
    let edgeDistance = limit
    for (const { paths } of near) {
      for (const path of paths) {
        for (let i = 0; i < path.length - 1; i++) {
          const start = path[i] as Position
          const end = path[i + 1] as Position
          // Ребро далеко от рамки допуска — без проекции
          if (
            Math.max(start[0], end[0]) < west ||
            Math.min(start[0], end[0]) > east ||
            Math.max(start[1], end[1]) < south ||
            Math.min(start[1], end[1]) > north
          ) {
            continue
          }
          const p1 = projection.project(start[0], start[1])
          const p2 = projection.project(end[0], end[1])
          const dx = p2.x - p1.x
          const dy = p2.y - p1.y
          const length = dx * dx + dy * dy
          if (length === 0) continue
          const t = Math.max(
            0,
            Math.min(1, ((point.x - p1.x) * dx + (point.y - p1.y) * dy) / length),
          )
          const d = (p1.x + t * dx - point.x) ** 2 + (p1.y + t * dy - point.y) ** 2
          if (d <= edgeDistance) {
            edgeDistance = d
            // На коротком ребре линейная интерполяция в градусах совпадает с Меркатором
            edge = [start[0] + t * (end[0] - start[0]), start[1] + t * (end[1] - start[1])]
          }
        }
      }
    }
    return edge ? { position: edge, kind: 'edge' } : null
  }
}
