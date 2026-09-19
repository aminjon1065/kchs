import type {
  PassportPeriod,
  QueryResult,
  TerritoryFeature,
  TerritoryPassport,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import { type GeoCollection, resultFeatures } from '../choropleth/geojson.js'

/** Ключи кэша паспорта: под `territory`, как карточка, — обновляются вместе. */
export const passportKeys = {
  passport: (id: string, period: PassportPeriod) => ['territory', id, 'passport', period] as const,
  boundary: (id: string) => ['territory', id, 'boundary'] as const,
  children: (id: string) => ['territory', id, 'children-shapes'] as const,
}

/** Показатели, привязанные показатели и поручения паспорта — с правами смотрящего. */
export const passportQuery = (id: string, period: PassportPeriod) =>
  queryOptions({
    queryKey: passportKeys.passport(id, period),
    queryFn: () =>
      http.get<TerritoryPassport>(`/gis/territories/${id}/passport`, { query: { period } }),
    staleTime: 60_000,
  })

/** Граница единицы, упрощённая под масштаб карты паспорта. */
export const boundaryQuery = (id: string) =>
  queryOptions({
    queryKey: passportKeys.boundary(id),
    queryFn: () =>
      http.get<TerritoryFeature>(`/gis/territories/${id}/geometry`, { query: { zoom: 9 } }),
    staleTime: 10 * 60_000,
    retry: false,
  })

/**
 * Границы дочерних единиц — системным датасетом «Территории» (ADR-0069): одним
 * запросом с правами смотрящего; объекты с идентификатором в свойстве `id`.
 */
export const childShapesQuery = (id: string) =>
  queryOptions({
    queryKey: passportKeys.children(id),
    queryFn: async (): Promise<GeoCollection> => {
      const result = await http.post<QueryResult>('/queries/run', {
        spec: {
          version: 1,
          source: { kind: 'system', name: 'territories' },
          steps: [
            {
              type: 'filter',
              where: {
                and: [
                  { field: 'parent_id', op: 'eq', value: id },
                  { field: 'geom', op: 'not_empty' },
                ],
              },
            },
            { type: 'select', fields: ['id', 'code', 'name', 'name_tg', 'name_en', 'geom'] },
          ],
        },
      })
      return resultFeatures(result, 'geom')
    },
    staleTime: 10 * 60_000,
  })
