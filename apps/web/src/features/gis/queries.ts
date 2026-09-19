import type {
  FieldOption,
  LayerFeature,
  LayerList,
  LayerRecord,
  MapRecord,
  Territory,
  TerritoryDetail,
  TerritoryList,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/** Ключи кэша справочника территорий, слоёв и карт. */
export const gisKeys = {
  territories: ['territories'] as const,
  territory: (id: string) => ['territory', id] as const,
  layer: (id: string) => ['layer', id] as const,
  datasetLayers: (datasetId: string) => ['layers', 'dataset', datasetId] as const,
  map: (id: string) => ['map', id] as const,
  feature: (layerId: string, rowId: string) => ['layer', layerId, 'feature', rowId] as const,
}

/** Слой: стиль, поля тайла, экстент и версия данных (ADR-0064). */
export const layerQuery = (id: string) =>
  queryOptions({
    queryKey: gisKeys.layer(id),
    queryFn: () => http.get<LayerRecord>(`/gis/layers/${id}`),
  })

/** Слои датасета, видимые пользователю, — «Показать на карте». */
export const datasetLayersQuery = (datasetId: string) =>
  queryOptions({
    queryKey: gisKeys.datasetLayers(datasetId),
    queryFn: async () => (await http.get<LayerList>('/gis/layers', { query: { datasetId } })).items,
  })

export const mapQuery = (id: string) =>
  queryOptions({
    queryKey: gisKeys.map(id),
    queryFn: () => http.get<MapRecord>(`/gis/maps/${id}`),
  })

/** Карточка объекта слоя по щелчку: видимые поля строки и геометрия. */
export const layerFeatureQuery = (layerId: string, rowId: string) =>
  queryOptions({
    queryKey: gisKeys.feature(layerId, rowId),
    queryFn: () => http.get<LayerFeature>(`/gis/layers/${layerId}/features/${rowId}`),
    staleTime: 30_000,
  })

/** Справочник территорий целиком: меняется редко — держится в кэше надолго. */
export const territoriesQuery = () =>
  queryOptions({
    queryKey: gisKeys.territories,
    queryFn: async () => (await http.get<TerritoryList>('/territories')).items,
    staleTime: 10 * 60_000,
  })

export const territoryQuery = (id: string) =>
  queryOptions({
    queryKey: gisKeys.territory(id),
    queryFn: () => http.get<TerritoryDetail>(`/territories/${id}`),
  })

/**
 * Единицы справочника как варианты поля-территории: грид и фильтры показывают
 * название, правка и вставка находят единицу по названию или коду.
 */
export function territoryOptions(items: readonly Territory[]): FieldOption[] {
  return items.map((item) => ({ value: item.id, label: item.name }))
}
