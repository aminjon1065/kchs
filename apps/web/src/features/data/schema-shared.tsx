import type { DatasetField, Locale } from '@kchs/contracts'
import { Field, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kchs/ui'
import { useQueryClient } from '@tanstack/react-query'
import { dataKeys } from './queries.js'

export const NONE = '__none'
export const FIELD_KEY = /^[a-z_][a-z0-9_]*$/

/** После правки схемы: датасет, версии и профили полей читаются заново. */
export function useSchemaRefresh(datasetId: string) {
  const client = useQueryClient()
  return () => {
    void client.invalidateQueries({ queryKey: dataKeys.dataset(datasetId) })
    void client.invalidateQueries({ queryKey: dataKeys.versions(datasetId) })
    void client.invalidateQueries({ queryKey: ['dataset', datasetId, 'profile'] })
  }
}

export const labelOf = (field: DatasetField, locale: Locale) =>
  field.label[locale] ?? field.label.ru ?? field.key

export function ChoiceField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <Field label={label}>
      <Select value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}
