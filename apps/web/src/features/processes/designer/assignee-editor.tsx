import type { PrincipalRef } from '@kchs/contracts'
import { localizedText } from '@kchs/i18n'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverAnchor,
  PopoverContent,
  SearchInput,
  Tag,
  useDebouncedValue,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Braces, Plus, Search, Shield, UserRound, Variable } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { PrincipalLine } from '~/features/access/principal-picker.js'
import { principalsQuery } from '~/shared/api/queries.js'
import { QUICK_ASSIGNEES, TIMER_ASSIGNEES } from '../assignees.js'
import { useAssigneeLabel, useDesigner } from './context.js'

const SPACE_ROLES = ['viewer', 'member', 'editor', 'admin'] as const
/** Типы переменных, которые назначают людей. */
const PEOPLE_VARIABLES = new Set(['user', 'users', 'unit', 'group'])

/**
 * Назначенные шага (08-documents.md §4): плашки выражений словами и меню
 * «Добавить» — частые формы (руководитель подразделения автора, автор…),
 * сотрудник, подразделение или группа поиском, роль, переменная запуска,
 * поле объекта и произвольное выражение (его проверяет сервер).
 */
export function AssigneeEditor({
  value,
  onChange,
  label,
  timer = false,
  single = false,
  allowEmpty = false,
}: {
  value: readonly string[]
  onChange: (next: string[]) => void
  label: string
  /** Эскалация: доступны не ответившие на просроченном шаге. */
  timer?: boolean
  /** Одно выражение (кому вернуть): добавление заменяет текущее. */
  single?: boolean
  allowEmpty?: boolean
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const labelOf = useAssigneeLabel()
  const { definition, roles, catalog, readOnly } = useDesigner()
  const [searching, setSearching] = useState(false)
  const [custom, setCustom] = useState<string | null>(null)
  const customId = useId()

  const add = (expression: string) => {
    const trimmed = expression.trim()
    if (!trimmed) return
    if (single) onChange([trimmed])
    else if (!value.includes(trimmed)) onChange([...value, trimmed])
  }
  const remove = (expression: string) => {
    if (!allowEmpty && value.length <= 1) return
    onChange(value.filter((item) => item !== expression))
  }
  const variables = Object.entries(definition.variables).filter(([, variable]) =>
    PEOPLE_VARIABLES.has(variable.type),
  )
  const fields =
    catalog?.objectTypes.find((item) => item.type === definition.objectType)?.fields ?? []
  const quick = timer ? TIMER_ASSIGNEES : QUICK_ASSIGNEES

  return (
    <div className="flex flex-col gap-1.5">
      <ul aria-label={label} className="flex flex-wrap items-center gap-1.5">
        {value.length === 0 ? (
          <li className="text-xs text-fg-muted">{t('processDesigner.assignee.empty')}</li>
        ) : null}
        {value.map((expression) => {
          const text = labelOf(expression)
          return (
            <li key={expression} title={expression}>
              <Tag
                {...(!readOnly && (allowEmpty || value.length > 1)
                  ? { onRemove: () => remove(expression) }
                  : {})}
              >
                {text}
              </Tag>
            </li>
          )
        })}
      </ul>
      {readOnly ? null : (
        <Popover open={searching} onOpenChange={setSearching}>
          <PopoverAnchor asChild>
            <div className="flex flex-wrap items-center gap-1.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm">
                    <Plus className="size-3.5" />
                    {single
                      ? t('processDesigner.assignee.change')
                      : t('processDesigner.assignee.add')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72">
                  {quick.map((item) => (
                    <DropdownMenuItem
                      key={item.expression}
                      icon={<UserRound className="size-3.5" />}
                      onSelect={() => add(item.expression)}
                    >
                      {t(`processDesigner.assignee.kinds.${item.kind}`)}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    icon={<Search className="size-3.5" />}
                    onSelect={() => setSearching(true)}
                  >
                    {t('processDesigner.assignee.addPerson')}
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger icon={<Shield className="size-3.5" />}>
                      {t('processDesigner.assignee.roles')}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto">
                      {roles.map((role) => (
                        <DropdownMenuItem key={role.key} onSelect={() => add(`role:${role.key}`)}>
                          {localizedText(role.name, locale)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger icon={<Shield className="size-3.5" />}>
                      {t('processDesigner.assignee.spaceRoles')}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto">
                      {SPACE_ROLES.map((role) => (
                        <DropdownMenuItem key={role} onSelect={() => add(`role_in_space:${role}`)}>
                          {t(`access.spaceRoles.${role}`)}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      {roles.map((role) => (
                        <DropdownMenuItem
                          key={role.key}
                          onSelect={() => add(`role_in_space:${role.key}`)}
                        >
                          {localizedText(role.name, locale)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger icon={<Variable className="size-3.5" />}>
                      {t('processDesigner.assignee.variables')}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-64">
                      {variables.length === 0 ? (
                        <DropdownMenuLabel>
                          {t('processDesigner.assignee.noVariables')}
                        </DropdownMenuLabel>
                      ) : (
                        variables.map(([name, variable]) => (
                          <DropdownMenuItem key={name} onSelect={() => add(`var:${name}`)}>
                            {localizedText(variable.label, locale)}
                          </DropdownMenuItem>
                        ))
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  {fields.length > 0 ? (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger icon={<Variable className="size-3.5" />}>
                        {t('processDesigner.assignee.fields')}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto">
                        {fields.map((field) => (
                          <DropdownMenuItem
                            key={field.path}
                            onSelect={() => add(`field:${field.path}`)}
                          >
                            {localizedText(field.label, locale)}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ) : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    icon={<Braces className="size-3.5" />}
                    onSelect={() => setCustom('')}
                  >
                    {t('processDesigner.assignee.addExpression')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {custom !== null ? (
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault()
                    add(custom)
                    setCustom(null)
                  }}
                >
                  <label htmlFor={customId} className="sr-only">
                    {t('processDesigner.assignee.expressionTitle')}
                  </label>
                  <Input
                    id={customId}
                    value={custom}
                    onChange={(event) => setCustom(event.target.value)}
                    placeholder="manager(field:curator)"
                    className="h-7 w-56 font-mono text-xs"
                    autoFocus
                  />
                  <Button type="submit" size="sm" disabled={!custom.trim()}>
                    {t('processDesigner.assignee.expressionAdd')}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setCustom(null)}>
                    {t('common.actions.cancel')}
                  </Button>
                </form>
              ) : null}
            </div>
          </PopoverAnchor>
          <PopoverContent className="w-80 p-2">
            <PrincipalSearch
              label={t('processDesigner.assignee.addPerson')}
              onPick={(principal) => {
                add(`${principal.type}:${principal.id}`)
                setSearching(false)
              }}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}

function PrincipalSearch({
  label,
  onPick,
}: {
  label: string
  onPick: (principal: PrincipalRef) => void
}) {
  const t = useT()
  const listId = useId()
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search.trim(), 200)
  const { data: found = [], isFetching } = useQuery(principalsQuery(query, 'user,unit,group'))
  return (
    <div className="flex flex-col gap-1.5">
      <SearchInput
        value={search}
        onValueChange={setSearch}
        placeholder={t('processDesigner.assignee.searchPlaceholder')}
        aria-label={label}
        aria-controls={listId}
        autoFocus
      />
      <ul id={listId} aria-label={label} className="max-h-60 overflow-y-auto">
        {found.map((principal) => (
          <li key={`${principal.type}:${principal.id}`}>
            <button
              type="button"
              onClick={() => onPick(principal)}
              className="flex w-full items-center rounded-xs px-2 py-1.5 text-left hover:bg-surface-3"
            >
              <PrincipalLine principal={principal} />
            </button>
          </li>
        ))}
        {query && !isFetching && found.length === 0 ? (
          <li className="px-2 py-1.5 text-sm text-fg-muted">
            {t('processDesigner.assignee.nothingFound')}
          </li>
        ) : null}
      </ul>
    </div>
  )
}
