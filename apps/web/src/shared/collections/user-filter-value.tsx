import type { FilterOperator, PrincipalRef } from '@kchs/contracts'
import { Checkbox, type FilterField, SearchInput, type ValueEditorProps } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { principalsQuery } from '~/shared/api/queries.js'

/** Имена выбранных людей для чипов фильтра (идентификаторы → подписи). */
const names = new Map<string, string>()

/** Редактор значения для полей-людей: поиск сотрудников и выбор нескольких. */
export function renderUserFilterValue(props: ValueEditorProps) {
  if (props.field.type !== 'user') return undefined
  if (props.op !== 'in' && props.op !== 'not_in') return undefined
  return <UserFilterValue {...props} />
}

export function describeUserFilterValue(
  field: FilterField,
  _op: FilterOperator,
  value: unknown,
): string | undefined {
  if (field.type !== 'user' || !Array.isArray(value)) return undefined
  const labels = (value as string[]).map((id) => names.get(id) ?? '…')
  return labels.length > 2
    ? `${labels.slice(0, 2).join(', ')} +${labels.length - 2}`
    : labels.join(', ')
}

function UserFilterValue({ value, onChange }: ValueEditorProps) {
  const t = useT()
  const [query, setQuery] = useState('')
  const { data: people = [] } = useQuery(principalsQuery(query, 'user'))
  const selected = new Set(Array.isArray(value) ? (value as string[]) : [])

  const toggle = (person: PrincipalRef, checked: boolean) => {
    names.set(person.id, person.title)
    const next = new Set(selected)
    if (checked) next.add(person.id)
    else next.delete(person.id)
    onChange([...next])
  }

  return (
    <div className="flex flex-col gap-2">
      <SearchInput
        autoFocus
        value={query}
        onValueChange={setQuery}
        placeholder={t('admin.users.searchPlaceholder')}
      />
      <ul className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
        {people.map((person) => (
          <li key={person.id}>
            <Checkbox
              label={person.title}
              checked={selected.has(person.id)}
              onCheckedChange={(checked) => toggle(person, checked === true)}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}
