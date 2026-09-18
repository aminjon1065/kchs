import type { DatasetField, FieldOption } from '@kchs/contracts'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { territoriesQuery, territoryOptions } from '~/features/gis/queries.js'
import { type LookupRef, lookupOptionsQuery } from './queries.js'

const lookupKey = (lookup: LookupRef) =>
  `${lookup.datasetId}:${lookup.keyField}:${lookup.labelField}`

/**
 * Справочные варианты полей датасета (ADR-0057): у поля-территории — единицы
 * справочника территорий, у поля со справочником — его подписи. Грид и фильтры
 * показывают подпись вместо значения и дают выбрать вариант.
 */
export function useFieldOptions(
  fields: readonly DatasetField[],
): ReadonlyMap<string, FieldOption[]> {
  const hasTerritory = fields.some((field) => field.type === 'territory')
  const { data: territories } = useQuery({ ...territoriesQuery(), enabled: hasTerritory })

  const lookups = useMemo(() => {
    const unique = new Map<string, LookupRef>()
    for (const field of fields) {
      if (field.lookup) unique.set(lookupKey(field.lookup), field.lookup)
    }
    return [...unique.values()]
  }, [fields])
  // combine отдаёт тот же массив, пока данные запросов не изменились
  const loaded = useQueries({
    queries: lookups.map((lookup) => lookupOptionsQuery(lookup)),
    combine: (results) => results.map((result) => result.data),
  })

  return useMemo(() => {
    const byLookup = new Map(lookups.map((lookup, index) => [lookupKey(lookup), loaded[index]]))
    const territoryChoices = territories ? territoryOptions(territories) : undefined
    const out = new Map<string, FieldOption[]>()
    for (const field of fields) {
      const options =
        field.type === 'territory'
          ? territoryChoices
          : field.lookup
            ? byLookup.get(lookupKey(field.lookup))
            : undefined
      if (options?.length) out.set(field.key, options)
    }
    return out
  }, [fields, lookups, territories, loaded])
}
