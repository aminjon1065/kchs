import type { FieldType, QuerySource } from '@kchs/contracts'
import type { CompileContext, ResolvedDataset } from '../src/index.js'
import { ctx, dataset, IDS, incidents, regions } from './fixtures.js'

/** Датасеты пространственных операций: зоны (полигоны), больницы (точки), дороги (линии). */
export const SPATIAL_IDS = {
  zones: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
  hospitals: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
  roads: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3',
} as const

type FieldSpec = [key: string, type: FieldType]

export const ZONE_FIELDS: FieldSpec[] = [
  ['name', 'text'],
  ['kind', 'select'],
  ['geom', 'geometry'],
]
export const HOSPITAL_FIELDS: FieldSpec[] = [
  ['name', 'text'],
  ['beds', 'integer'],
  ['geom', 'geometry'],
]
export const ROAD_FIELDS: FieldSpec[] = [
  ['name', 'text'],
  ['geom', 'geometry'],
]

export const zones = dataset(SPATIAL_IDS.zones, 'ds.t_zones', ZONE_FIELDS, { version: 4 })
export const hospitals = dataset(SPATIAL_IDS.hospitals, 'ds.t_hospitals', HOSPITAL_FIELDS, {
  version: 5,
})
export const roads = dataset(SPATIAL_IDS.roads, 'ds.t_roads', ROAD_FIELDS, { version: 6 })

/**
 * Справочник территорий — как системный датасет API (`ds.sys_territories`):
 * физические имена совпадают с ключами, системных столбцов строк нет.
 */
export function territoriesDataset(table = 'ds.sys_territories'): ResolvedDataset {
  const field = (key: string, type: FieldType) => ({
    key,
    type,
    physical: key,
    label: { ru: key },
    semantic: null,
    format: null,
  })
  return {
    id: 'system:territories',
    table,
    fields: [
      field('id', 'territory'),
      field('code', 'identifier'),
      field('level', 'select'),
      field('parent_id', 'territory'),
      field('name', 'text'),
      field('geom', 'geometry'),
      field('area_km2', 'number'),
    ],
    rowPolicy: { kind: 'all' },
    columnPolicy: { hide: [], mask: [] },
    version: 0,
    systemColumns: false,
  }
}

/** Контекст с пространственными датасетами и справочником территорий. */
export function spatialContext(
  list: ResolvedDataset[] = [incidents, regions, zones, hospitals, roads],
  territories: ResolvedDataset | null = territoriesDataset(),
): Partial<CompileContext> {
  const datasets = new Map(ctx().datasets)
  for (const item of list) datasets.set(item.id, item)
  return {
    datasets,
    systemDatasets: new Map(territories ? [['territories', territories]] : []),
  }
}

export const zonesSource = (alias?: string): QuerySource => ({
  kind: 'dataset',
  id: SPATIAL_IDS.zones,
  ...(alias ? { alias } : {}),
})

export const incidentsSource = (alias?: string): QuerySource => ({
  kind: 'dataset',
  id: IDS.incidents,
  ...(alias ? { alias } : {}),
})

/** Прямоугольник GeoJSON по углам (долгота, широта). */
export function box(west: number, south: number, east: number, north: number) {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  }
}
