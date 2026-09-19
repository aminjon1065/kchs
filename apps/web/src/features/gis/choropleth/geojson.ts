import type { Bbox, QueryResult } from '@kchs/contracts'
import type { StyleField } from '@kchs/map-style'

/** Объект GeoJSON с произвольной геометрией — для источников карт в браузере. */
export interface GeoFeature {
  type: 'Feature'
  geometry: Record<string, unknown> | null
  properties: Record<string, unknown>
}

export interface GeoCollection {
  type: 'FeatureCollection'
  features: GeoFeature[]
}

/**
 * Результат запроса → GeoJSON: геометрия — из поля `geometryField` (компилятор
 * отдаёт её GeoJSON), остальные поля — свойства. Строки без геометрии пропускаются.
 */
export function resultFeatures(result: QueryResult, geometryField: string): GeoCollection {
  const index = result.fields.findIndex((field) => field.name === geometryField)
  const features: GeoFeature[] = []
  for (const row of result.rows) {
    const geometry = index >= 0 ? row[index] : null
    if (!geometry || typeof geometry !== 'object') continue
    const properties: Record<string, unknown> = {}
    result.fields.forEach((field, position) => {
      if (position !== index) properties[field.name] = row[position]
    })
    features.push({ type: 'Feature', geometry: geometry as Record<string, unknown>, properties })
  }
  return { type: 'FeatureCollection', features }
}

/** Поля результата как поля стиля: подписи легенды и форматы чисел. */
export function resultStyleFields(result: QueryResult): StyleField[] {
  return result.fields.map((field) => ({
    key: field.name,
    type: field.type,
    label: field.label,
    format: field.format,
  }))
}

function visit(coordinates: unknown, box: [number, number, number, number]): void {
  if (!Array.isArray(coordinates)) return
  if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
    const [lon, lat] = coordinates as [number, number]
    box[0] = Math.min(box[0], lon)
    box[1] = Math.min(box[1], lat)
    box[2] = Math.max(box[2], lon)
    box[3] = Math.max(box[3], lat)
    return
  }
  for (const item of coordinates) visit(item, box)
}

/** Охват объектов [запад, юг, восток, север]; без координат — null. */
export function featuresBbox(collection: GeoCollection): Bbox | null {
  const box: [number, number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]
  for (const feature of collection.features) {
    const geometry = feature.geometry
    if (!geometry) continue
    if (geometry.type === 'GeometryCollection' && Array.isArray(geometry.geometries)) {
      for (const part of geometry.geometries as Array<{ coordinates?: unknown }>) {
        visit(part.coordinates, box)
      }
    } else visit(geometry.coordinates, box)
  }
  return Number.isFinite(box[0]) ? box : null
}

/** Числовые значения свойства объектов — для классов и подписи диапазона. */
export function numericValues(collection: GeoCollection, key: string): number[] {
  const values: number[] = []
  for (const feature of collection.features) {
    const value = feature.properties[key]
    const number = typeof value === 'number' ? value : value === null ? Number.NaN : Number(value)
    if (Number.isFinite(number)) values.push(number)
  }
  return values
}
