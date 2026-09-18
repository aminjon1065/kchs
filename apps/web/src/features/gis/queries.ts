import type { FieldOption, Territory, TerritoryDetail, TerritoryList } from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/** Ключи кэша справочника территорий. */
export const gisKeys = {
  territories: ['territories'] as const,
  territory: (id: string) => ['territory', id] as const,
}

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
