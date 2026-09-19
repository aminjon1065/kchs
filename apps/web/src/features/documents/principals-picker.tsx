import type { PrincipalRef } from '@kchs/contracts'
import { Button, SearchInput, useDebouncedValue } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { PrincipalLine } from '~/features/access/principal-picker.js'
import { principalsQuery } from '~/shared/api/queries.js'

/**
 * Выбор нескольких принципалов — сотрудников, подразделений, групп (список
 * ознакомления, подразделения правила типа): выбранные — списком с кнопкой
 * «убрать», добавление — поиском.
 */
export function PrincipalsPicker({
  value,
  onChange,
  label,
  types = 'user,unit,group',
}: {
  value: PrincipalRef[]
  onChange: (next: PrincipalRef[]) => void
  label: string
  types?: string
}) {
  const t = useT()
  const listId = useId()
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search.trim(), 200)
  const { data: found = [], isFetching } = useQuery(principalsQuery(query, types))
  const chosen = new Set(value.map((item) => `${item.type}:${item.id}`))
  const options = found.filter((item) => !chosen.has(`${item.type}:${item.id}`))

  return (
    <div className="flex flex-col gap-1.5">
      {value.length > 0 ? (
        <ul aria-label={label} className="flex flex-col gap-1">
          {value.map((principal) => (
            <li
              key={`${principal.type}:${principal.id}`}
              className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5"
            >
              <PrincipalLine principal={principal} />
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  onChange(
                    value.filter(
                      (item) => !(item.type === principal.type && item.id === principal.id),
                    ),
                  )
                }
              >
                {t('common.actions.remove')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <SearchInput
        value={search}
        onValueChange={setSearch}
        placeholder={t('documents.picker.placeholder')}
        aria-label={label}
        aria-controls={listId}
      />
      {query ? (
        <ul
          id={listId}
          aria-label={t('documents.picker.results', { label })}
          className="max-h-48 overflow-y-auto rounded-md border border-line p-1"
        >
          {options.map((principal) => (
            <li key={`${principal.type}:${principal.id}`}>
              <button
                type="button"
                onClick={() => {
                  onChange([...value, principal])
                  setSearch('')
                }}
                className="flex w-full items-center rounded-xs px-2 py-1.5 text-left hover:bg-surface-3"
              >
                <PrincipalLine principal={principal} />
              </button>
            </li>
          ))}
          {!isFetching && options.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-fg-muted">{t('documents.picker.empty')}</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}
