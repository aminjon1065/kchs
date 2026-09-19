import { describe, expect, it } from 'vitest'
import { FeatureEditInput, FeatureGeometry, LayerFeatureDelete } from '../feature-edit.js'

/** Контракт правки объектов слоя (ADR-0076): геометрия GeoJSON и предложения правок. */
describe('геометрия объекта слоя', () => {
  it('точка с высотой принимается, координаты вне WGS 84 — нет', () => {
    expect(FeatureGeometry.safeParse({ type: 'Point', coordinates: [68.7, 38.5] }).success).toBe(
      true,
    )
    expect(
      FeatureGeometry.safeParse({ type: 'Point', coordinates: [68.7, 38.5, 812] }).success,
    ).toBe(true)
    expect(FeatureGeometry.safeParse({ type: 'Point', coordinates: [200, 38.5] }).success).toBe(
      false,
    )
    expect(FeatureGeometry.safeParse({ type: 'Point', coordinates: [68.7] }).success).toBe(false)
  })

  it('кольцо полигона замкнуто и не короче четырёх координат', () => {
    const closed = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ]
    expect(FeatureGeometry.safeParse({ type: 'Polygon', coordinates: [closed] }).success).toBe(true)
    const open = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]
    expect(FeatureGeometry.safeParse({ type: 'Polygon', coordinates: [open] }).success).toBe(false)
    expect(
      FeatureGeometry.safeParse({ type: 'Polygon', coordinates: [closed.slice(1)] }).success,
    ).toBe(false)
  })

  it('линия — от двух вершин; неизвестный тип — ошибка', () => {
    expect(
      FeatureGeometry.safeParse({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      }).success,
    ).toBe(true)
    expect(FeatureGeometry.safeParse({ type: 'LineString', coordinates: [[0, 0]] }).success).toBe(
      false,
    )
    expect(FeatureGeometry.safeParse({ type: 'GeometryCollection', geometries: [] }).success).toBe(
      false,
    )
  })
})

describe('предложение правки', () => {
  it('изменение и удаление — со строкой и версией; создание — с геометрией', () => {
    expect(FeatureEditInput.safeParse({ op: 'delete', rowId: '5', ver: 2 }).success).toBe(true)
    expect(FeatureEditInput.safeParse({ op: 'delete', rowId: '5' }).success).toBe(false)
    expect(FeatureEditInput.safeParse({ op: 'update', rowId: '5', ver: 1 }).success).toBe(true)
    expect(FeatureEditInput.safeParse({ op: 'create', values: {} }).success).toBe(false)
    const created = FeatureEditInput.parse({
      op: 'create',
      geometry: { type: 'Point', coordinates: [69, 38] },
    })
    expect(created).toMatchObject({ op: 'create', values: {} })
  })

  it('версия удаления приходит строкой адреса', () => {
    expect(LayerFeatureDelete.parse({ ver: '3' })).toEqual({ ver: 3 })
    expect(LayerFeatureDelete.safeParse({ ver: '0' }).success).toBe(false)
  })
})
