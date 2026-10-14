import type { FieldOption, Territory } from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import { cachedFetch, OFFLINE_AWARE } from '~/shared/offline/queue.js'

/** Ключи кэша справочника территорий. */
export const territoryKeys = {
  all: ['territories'] as const,
  one: (id: string) => ['territory', id] as const,
}

/** Справочник территорий целиком: меняется редко — держится в кэше надолго. */
export const territoriesQuery = () =>
  queryOptions({
    // Район в донесении и сводке выбирают и без сети — справочник с устройства (ADR-0212)
    ...OFFLINE_AWARE,
    queryKey: territoryKeys.all,
    queryFn: () => cachedFetch('territories', async () => (await http.get('/territories')).items),
    staleTime: 10 * 60_000,
  })

export const territoryQuery = (id: string) =>
  queryOptions({
    queryKey: territoryKeys.one(id),
    queryFn: () => http.get('/territories/:id', { params: { id } }),
  })

/**
 * Единицы справочника как варианты поля-территории: грид и фильтры показывают
 * название, правка и вставка находят единицу по названию или коду.
 */
export function territoryOptions(items: readonly Territory[]): FieldOption[] {
  return items.map((item) => ({ value: item.id, label: item.name }))
}
