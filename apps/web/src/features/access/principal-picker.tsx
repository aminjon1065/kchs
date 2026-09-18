import type { PrincipalRef } from '@kchs/contracts'
import { Avatar, Button, SearchInput, useDebouncedValue } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { principalsQuery } from '~/shared/api/queries.js'

/** Роли пространства ниже «Администратор»: управляющих политики доступа не ограничивают. */
const SPACE_ROLES = ['viewer', 'member', 'editor'] as const

/** Подпись принципала на языке интерфейса: «все» и роли пространства — из словаря. */
export function usePrincipalLabel() {
  const t = useT()
  return (principal: PrincipalRef): { title: string; subtitle?: string } => {
    if (principal.type === 'everyone') return { title: t('access.picker.everyone') }
    if (principal.type === 'space_role') {
      const role = principal.id.slice(principal.id.lastIndexOf(':') + 1)
      return {
        title: t('access.picker.spaceRole', { role: t(`access.spaceRoles.${role}`) }),
        ...(principal.title ? { subtitle: principal.title } : {}),
      }
    }
    return {
      title: principal.title,
      ...(principal.subtitle ? { subtitle: principal.subtitle } : {}),
    }
  }
}

export function PrincipalLine({ principal }: { principal: PrincipalRef }) {
  const labelOf = usePrincipalLabel()
  const { title, subtitle } = labelOf(principal)
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <Avatar name={title} src={principal.avatarUrl} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-fg" title={title}>
          {title}
        </span>
        {subtitle ? (
          <span className="block truncate text-xs text-fg-muted" title={subtitle}>
            {subtitle}
          </span>
        ) : null}
      </span>
    </span>
  )
}

/**
 * Выбор одного принципала: поиск людей, подразделений, групп и должностей и
 * быстрый выбор — «все сотрудники» и роли пространства объекта.
 */
export function PrincipalPicker({
  value,
  onChange,
  spaceId,
  label,
}: {
  value: PrincipalRef | null
  onChange: (principal: PrincipalRef | null) => void
  /** Пространство объекта: его роли — в быстром выборе. */
  spaceId?: string
  label: string
}) {
  const t = useT()
  const listId = useId()
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search.trim(), 200)
  const { data: found = [], isFetching } = useQuery(principalsQuery(query))

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-2">
        <PrincipalLine principal={value} />
        <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
          {t('access.picker.change')}
        </Button>
      </div>
    )
  }

  const quick: PrincipalRef[] = [
    { type: 'everyone', id: '*', title: '' },
    ...(spaceId
      ? SPACE_ROLES.map((role) => ({
          type: 'space_role' as const,
          id: `${spaceId}:${role}`,
          title: '',
        }))
      : []),
  ]
  const items = query ? found : quick
  return (
    <div className="flex flex-col gap-1.5">
      <SearchInput
        value={search}
        onValueChange={setSearch}
        placeholder={t('access.picker.placeholder')}
        aria-label={label}
        aria-controls={listId}
      />
      <ul
        id={listId}
        aria-label={query ? label : t('access.picker.quick')}
        className="max-h-56 overflow-y-auto rounded-md border border-line p-1"
      >
        {items.map((principal) => (
          <li key={`${principal.type}:${principal.id}`}>
            <button
              type="button"
              onClick={() => {
                onChange(principal)
                setSearch('')
              }}
              className="flex w-full items-center rounded-xs px-2 py-1.5 text-left hover:bg-surface-3"
            >
              <PrincipalLine principal={principal} />
            </button>
          </li>
        ))}
        {query && !isFetching && found.length === 0 ? (
          <li className="px-2 py-1.5 text-sm text-fg-muted">{t('access.picker.nothingFound')}</li>
        ) : null}
      </ul>
    </div>
  )
}
