import { Avatar, Button, IconButton, SearchInput, useDebouncedValue } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { principalsQuery } from '~/shared/api/queries.js'

/** Участник встречи в форме. */
export interface Invitee {
  id: string
  title: string
  subtitle?: string | null
  avatarUrl?: string | null
  optional: boolean
  /** Ответ, если он уже есть (правка события). */
  status?: string | null
}

/**
 * Участники встречи: поиск сотрудников, список выбранных с пометкой
 * «необязательно» и удалением.
 */
export function PeoplePicker({
  value,
  onChange,
  exclude = [],
  label,
}: {
  value: Invitee[]
  onChange: (next: Invitee[]) => void
  /** Кого не предлагать (организатор). */
  exclude?: string[]
  label: string
}) {
  const t = useT()
  const listId = useId()
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search.trim(), 200)
  const { data: found = [], isFetching } = useQuery(principalsQuery(query, 'user'))
  const chosen = new Set(value.map((item) => item.id))
  const options = found.filter((item) => !chosen.has(item.id) && !exclude.includes(item.id))

  return (
    <div className="flex flex-col gap-1.5">
      {value.length > 0 ? (
        <ul aria-label={label} className="flex flex-col gap-1">
          {value.map((person) => (
            <li
              key={person.id}
              className="flex items-center gap-2 rounded-md border border-line bg-surface px-2 py-1"
            >
              <Avatar name={person.title} src={person.avatarUrl ?? null} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-fg">{person.title}</span>
                {person.subtitle ? (
                  <span className="block truncate text-2xs text-fg-muted">{person.subtitle}</span>
                ) : null}
              </span>
              {person.status ? (
                <span className="shrink-0 text-2xs text-fg-muted">
                  {t(`calendar.status.${person.status}`)}
                </span>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={person.optional}
                onClick={() =>
                  onChange(
                    value.map((item) =>
                      item.id === person.id ? { ...item, optional: !item.optional } : item,
                    ),
                  )
                }
              >
                {person.optional ? t('calendar.event.optional') : t('calendar.event.required')}
              </Button>
              <IconButton
                size="sm"
                label={t('calendar.event.removeAttendee', { name: person.title })}
                onClick={() => onChange(value.filter((item) => item.id !== person.id))}
              >
                <X className="size-3.5" aria-hidden />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : null}
      <SearchInput
        value={search}
        onValueChange={setSearch}
        placeholder={t('calendar.event.addAttendee')}
        aria-label={t('calendar.event.addAttendee')}
        aria-controls={listId}
      />
      {query ? (
        <ul
          id={listId}
          aria-label={t('calendar.event.attendeeResults')}
          className="max-h-44 overflow-y-auto rounded-md border border-line p-1"
        >
          {options.map((principal) => (
            <li key={principal.id}>
              <button
                type="button"
                onClick={() => {
                  onChange([
                    ...value,
                    {
                      id: principal.id,
                      title: principal.title,
                      subtitle: principal.subtitle ?? null,
                      avatarUrl: principal.avatarUrl ?? null,
                      optional: false,
                    },
                  ])
                  setSearch('')
                }}
                className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left hover:bg-surface-3"
              >
                <Avatar name={principal.title} src={principal.avatarUrl ?? null} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">{principal.title}</span>
                  {principal.subtitle ? (
                    <span className="block truncate text-xs text-fg-muted">
                      {principal.subtitle}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
          {!isFetching && options.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-fg-muted">{t('tasks.picker.nothingFound')}</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}
