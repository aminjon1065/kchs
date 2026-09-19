import type { CorrespondentRecord, CorrespondentRef } from '@kchs/contracts'
import { Button, ObjectIcon, SearchInput, useDebouncedValue, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'
import { correspondentsQuery, documentKeys } from './queries.js'
import { errorText } from './status.js'

/**
 * Выбор корреспондента в карточке (08-documents.md §5): поиск по названию,
 * короткому имени и ИНН; делопроизводитель заводит нового прямо из поиска.
 */
export function CorrespondentPicker({
  value,
  onChange,
  label,
  canCreate,
  disabled,
  invalid,
}: {
  value: CorrespondentRef | null
  onChange: (value: CorrespondentRef | null) => void
  label: string
  canCreate: boolean
  disabled?: boolean
  invalid?: boolean
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const listId = useId()
  const [search, setSearch] = useState('')
  const q = useDebouncedValue(search.trim(), 200)
  const { data, isFetching } = useQuery({ ...correspondentsQuery(q), enabled: q.length > 0 })
  const found = data?.items ?? []

  const create = useMutation({
    mutationFn: () =>
      http.post<CorrespondentRecord>('/correspondents', { kind: 'organization', name: q }),
    onSuccess: (record) => {
      void client.invalidateQueries({ queryKey: documentKeys.all })
      onChange({ id: record.id, kind: record.kind, name: record.name })
      setSearch('')
      toast.show({ title: t('documents.correspondents.created'), tone: 'success' })
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  if (value) {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5"
        data-invalid={invalid ? '' : undefined}
      >
        <ObjectIcon type="correspondent" className="size-4 shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate text-sm text-fg" title={value.name}>
          {value.name}
        </span>
        {disabled ? null : (
          <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
            {t('tasks.picker.change')}
          </Button>
        )}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <SearchInput
        value={search}
        onValueChange={setSearch}
        placeholder={t('documents.correspondents.searchPlaceholder')}
        aria-label={label}
        aria-controls={listId}
        aria-invalid={invalid || undefined}
        disabled={disabled}
      />
      {q ? (
        <ul
          id={listId}
          aria-label={label}
          className="max-h-52 overflow-y-auto rounded-md border border-line p-1"
        >
          {found.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => {
                  onChange({ id: item.id, kind: item.kind, name: item.name })
                  setSearch('')
                }}
                className="flex w-full flex-col items-start rounded-xs px-2 py-1.5 text-left hover:bg-surface-3"
              >
                <span className="text-sm text-fg">{item.name}</span>
                {item.details.shortName || item.details.taxId ? (
                  <span className="text-xs text-fg-muted">
                    {[item.details.shortName, item.details.taxId].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
          {!isFetching && found.length === 0 ? (
            <li className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm text-fg-muted">
              <span>{t('tasks.picker.nothingFound')}</span>
              {canCreate ? (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Plus className="size-3.5" />}
                  loading={create.isPending}
                  onClick={() => create.mutate()}
                >
                  {t('documents.correspondents.createNamed', { name: q })}
                </Button>
              ) : null}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}
