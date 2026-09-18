import type { FilterBuilderProps } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { territoriesQuery } from './queries.js'
import { TerritoryTree } from './territory-tree.js'

/** Идентификатор территории из значения условия: строка или `{id, includeChildren}`. */
function selectedOf(value: unknown): string | null {
  if (typeof value === 'string' && value) return value
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
    return value.id
  }
  return null
}

/**
 * Редактор значения фильтра по полю-территории: дерево справочника с поиском
 * для «в пределах» (с вложенными) и «равно». Остальные условия — редакторы
 * конструктора по умолчанию (список вариантов).
 */
export function useTerritoryFilterEditor(enabled = true): FilterBuilderProps['renderValue'] {
  const locale = useAppearance((s) => s.locale)
  const { data: items } = useQuery({ ...territoriesQuery(), enabled })
  return useCallback<NonNullable<FilterBuilderProps['renderValue']>>(
    ({ field, op, value, onChange }) => {
      if (field.type !== 'territory' || !items || (op !== 'within' && op !== 'eq')) {
        return undefined
      }
      return (
        <div className="flex h-72 min-h-0 flex-col">
          <TerritoryTree
            items={items}
            selectedId={selectedOf(value)}
            onSelect={(territory) => onChange(territory.id)}
            locale={locale}
          />
        </div>
      )
    },
    [items, locale],
  )
}
