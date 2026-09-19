import type { DatasetRecord, Locale } from '@kchs/contracts'
import { formatValue } from '@kchs/fields'
import { useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { meQuery } from '~/shared/api/queries.js'
import { useFieldOptions } from '../../data/field-options.js'

/**
 * Значение поля датасета текстом — для истории, очереди правок и различий
 * версий: варианты выбора, территории и справочники — подписями (ADR-0057),
 * остальное — форматом поля на языке интерфейса и в поясе пользователя.
 */
export function useFieldText(dataset: DatasetRecord): (key: string, value: unknown) => string {
  const locale = useAppearance((s) => s.locale) as Locale
  const { data: me } = useQuery(meQuery())
  const options = useFieldOptions(dataset.fields)
  const timezone = me?.user.timezone
  return useCallback(
    (key: string, value: unknown) => {
      if (value === null || value === undefined || value === '') return '—'
      const field = dataset.fields.find((item) => item.key === key)
      if (!field) return String(value)
      const choice =
        typeof value === 'string'
          ? (options.get(key) ?? field.options)?.find((option) => option.value === value)
          : undefined
      if (choice) return choice.label[locale] ?? choice.label.ru
      return (
        formatValue(value, field, { locale, ...(timezone ? { timezone } : {}) }) || String(value)
      )
    },
    [dataset.fields, options, locale, timezone],
  )
}
