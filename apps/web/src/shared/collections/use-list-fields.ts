import type { ListFieldsResponse } from '@kchs/contracts'
import type { FilterField } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'

/** Схема полей списка (общие + поля модулей) с подписями на языке интерфейса. */
export function useListFields(types: string[]): { fields: FilterField[]; sortable: string[] } {
  const t = useT()
  const key = types.join(',')
  const { data } = useQuery({
    queryKey: ['objects', 'fields', key],
    queryFn: () => http.get<ListFieldsResponse>('/objects/fields', { query: { types: key } }),
    staleTime: 10 * 60_000,
  })
  return useMemo(() => {
    const items = data?.items ?? []
    return {
      fields: items.map((field) => ({
        key: field.key,
        label: t(field.labelKey),
        type: field.type,
        options:
          field.key === 'type'
            ? types.map((type) => ({ value: type, label: t(`objects.types.${type}`) }))
            : field.options?.map((option) => ({ value: option.value, label: t(option.labelKey) })),
      })),
      sortable: items.filter((field) => field.sortable).map((field) => field.key),
    }
    // t меняется при смене языка вместе с подписями
  }, [data, t, types])
}
