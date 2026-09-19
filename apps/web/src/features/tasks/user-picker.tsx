import { Avatar, Button, SearchInput, useDebouncedValue } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { principalsQuery } from '~/shared/api/queries.js'

/** Выбранный сотрудник: как его показать. */
export interface PickedUser {
  id: string
  title: string
  subtitle?: string | null
  avatarUrl?: string | null
}

function UserLine({ user }: { user: PickedUser }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <Avatar name={user.title} src={user.avatarUrl ?? null} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-fg" title={user.title}>
          {user.title}
        </span>
        {user.subtitle ? (
          <span className="block truncate text-xs text-fg-muted" title={user.subtitle}>
            {user.subtitle}
          </span>
        ) : null}
      </span>
    </span>
  )
}

/**
 * Выбор нескольких сотрудников (соисполнители поручения): выбранные — списком
 * с кнопкой «убрать», добавление — тем же поиском, что у одного сотрудника.
 */
export function UsersPicker({
  value,
  onChange,
  label,
  exclude = [],
}: {
  value: PickedUser[]
  onChange: (users: PickedUser[]) => void
  label: string
  /** Кого нельзя добавить (исполнитель поручения). */
  exclude?: readonly string[]
}) {
  const t = useT()
  return (
    <div className="flex flex-col gap-1.5">
      {value.length > 0 ? (
        <ul aria-label={label} className="flex flex-col gap-1">
          {value.map((user) => (
            <li
              key={user.id}
              className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5"
            >
              <UserLine user={user} />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onChange(value.filter((item) => item.id !== user.id))}
              >
                {t('common.actions.remove')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <UserPicker
        value={null}
        label={t('tasks.create.addCoAssignee')}
        onChange={(user) => {
          if (!user || exclude.includes(user.id) || value.some((item) => item.id === user.id)) {
            return
          }
          onChange([...value, user])
        }}
      />
    </div>
  )
}

/** Выбор одного сотрудника поиском по имени и логину (исполнитель, контролёр). */
export function UserPicker({
  value,
  onChange,
  label,
}: {
  value: PickedUser | null
  onChange: (user: PickedUser | null) => void
  label: string
}) {
  const t = useT()
  const listId = useId()
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search.trim(), 200)
  const { data: found = [], isFetching } = useQuery(principalsQuery(query, 'user'))

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-2">
        <UserLine user={value} />
        <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
          {t('tasks.picker.change')}
        </Button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <SearchInput
        value={search}
        onValueChange={setSearch}
        placeholder={t('tasks.picker.placeholder')}
        aria-label={label}
        aria-controls={listId}
      />
      {query ? (
        <ul
          id={listId}
          aria-label={label}
          className="max-h-48 overflow-y-auto rounded-md border border-line p-1"
        >
          {found.map((principal) => (
            <li key={principal.id}>
              <button
                type="button"
                onClick={() => {
                  onChange({
                    id: principal.id,
                    title: principal.title,
                    subtitle: principal.subtitle ?? null,
                    avatarUrl: principal.avatarUrl ?? null,
                  })
                  setSearch('')
                }}
                className="flex w-full items-center rounded-xs px-2 py-1.5 text-left hover:bg-surface-3"
              >
                <UserLine
                  user={{
                    id: principal.id,
                    title: principal.title,
                    subtitle: principal.subtitle ?? null,
                    avatarUrl: principal.avatarUrl ?? null,
                  }}
                />
              </button>
            </li>
          ))}
          {!isFetching && found.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-fg-muted">{t('tasks.picker.nothingFound')}</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}
