import type { FeatureGeometry } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  bboxOf,
  buildGeometry,
  drawKindsFor,
  editablePositions,
  formatCoordinates,
  mergeParts,
  parseCoordinates,
  representativePoint,
  sameGeometry,
  splitParts,
} from './geometry.js'
import { SnapIndex, type SnapProjection } from './snap.js'

const square: FeatureGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ],
  ],
}

describe('части геометрии', () => {
  it('составная делится на части и собирается обратно; одиночная остаётся одиночной', () => {
    const multi: FeatureGeometry = {
      type: 'MultiPolygon',
      coordinates: [square.coordinates as never, square.coordinates as never],
    }
    const parts = splitParts(multi)
    expect(parts).toHaveLength(2)
    expect(mergeParts(parts, true)?.type).toBe('MultiPolygon')
    expect(mergeParts(parts.slice(0, 1), false)).toEqual(square)
    expect(mergeParts(parts.slice(0, 1), true)?.type).toBe('MultiPolygon')
    expect(mergeParts([], false)).toBeNull()
  })

  it('высота координат отбрасывается', () => {
    expect(splitParts({ type: 'Point', coordinates: [69, 38, 800] })).toEqual([
      { type: 'Point', coordinates: [69, 38] },
    ])
  })

  it('инструменты по типу слоя', () => {
    expect(drawKindsFor('polygon')).toEqual(['polygon'])
    expect(drawKindsFor('mixed')).toEqual(['point', 'line', 'polygon'])
  })
})

describe('точка для авто-территории', () => {
  it('квадрат — центр; линия — средняя вершина; точка — сама', () => {
    expect(representativePoint(square)).toEqual([1, 1])
    expect(
      representativePoint({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
      }),
    ).toEqual([1, 1])
    expect(representativePoint({ type: 'Point', coordinates: [5, 6] })).toEqual([5, 6])
  })

  it('подкова: центроид снаружи — берётся точка внутри контура', () => {
    const horseshoe: FeatureGeometry = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [3, 0],
          [3, 3],
          [2, 3],
          [2, 1],
          [1, 1],
          [1, 3],
          [0, 3],
          [0, 0],
        ],
      ],
    }
    const point = representativePoint(horseshoe)
    expect(point).not.toBeNull()
    const [x, y] = point as [number, number]
    // Внутри левой или правой «ноги» подковы, а не в вырезе между ними
    expect(x < 1 || x > 2 || y < 1).toBe(true)
  })

  it('охват и сравнение с точностью до сантиметров', () => {
    expect(bboxOf(square)).toEqual([0, 0, 2, 2])
    expect(sameGeometry(square, JSON.parse(JSON.stringify(square)))).toBe(true)
    expect(
      sameGeometry(
        { type: 'Point', coordinates: [1, 2] },
        { type: 'Point', coordinates: [1, 2.001] },
      ),
    ).toBe(false)
  })
})

describe('координаты вручную', () => {
  it('строки «широта, долгота»: запятая, точка с запятой, пробел; пустые пропускаются', () => {
    expect(parseCoordinates('38.56, 68.78\n\n38.5;68.7\n38.4 68.6')).toEqual([
      [68.78, 38.56],
      [68.7, 38.5],
      [68.6, 38.4],
    ])
  })

  it('ошибки — с номером строки', () => {
    expect(parseCoordinates('38.5, 68.7\nабв')).toEqual({ line: 2, reason: 'format' })
    expect(parseCoordinates('95, 68')).toEqual({ line: 1, reason: 'lat' })
    expect(parseCoordinates('38, 190')).toEqual({ line: 1, reason: 'lon' })
  })

  it('геометрия из вершин: кольцо полигона замыкается, мало вершин — ошибка', () => {
    const polygon = buildGeometry('polygon', [
      [0, 0],
      [1, 0],
      [1, 1],
    ])
    expect(polygon).toEqual({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    })
    expect(buildGeometry('line', [[0, 0]])).toEqual({ line: 0, reason: 'count' })
    expect(buildGeometry('point', [[1, 2]])).toEqual({ type: 'Point', coordinates: [1, 2] })
  })

  it('вершины существующего объекта — в текст и обратно', () => {
    const positions = editablePositions(square)
    expect(positions).toHaveLength(4)
    const text = formatCoordinates(positions ?? [])
    expect(text.split('\n')[1]).toBe('0, 2')
    expect(parseCoordinates(text)).toEqual(positions)
    expect(editablePositions({ type: 'MultiPoint', coordinates: [[1, 2]] })).toBeNull()
  })
})

describe('привязка', () => {
  // Экран: 100 пикселей на градус, ось Y вниз
  const projection: SnapProjection = {
    project: (lng, lat) => ({ x: lng * 100, y: -lat * 100 }),
    unproject: (x, y) => ({ lng: x / 100, lat: -y / 100 }),
  }
  const index = new SnapIndex([square, { type: 'Point', coordinates: [5, 5] }, null])

  it('ближайшая вершина в пределах допуска', () => {
    expect(index.size).toBe(2)
    expect(index.nearest({ x: 203, y: -198 }, projection, 10)).toEqual({
      position: [2, 2],
      kind: 'vertex',
    })
    expect(index.nearest({ x: 504, y: -503 }, projection, 10)?.position).toEqual([5, 5])
  })

  it('иначе — точка на ребре; далеко — ничего', () => {
    const edge = index.nearest({ x: 100, y: -4 }, projection, 10)
    expect(edge?.kind).toBe('edge')
    expect(edge?.position[0]).toBeCloseTo(1, 6)
    expect(edge?.position[1]).toBeCloseTo(0, 6)
    expect(index.nearest({ x: 100, y: -100 }, projection, 10)).toBeNull()
  })
})
