import type { ObjectSummary } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import { localizedText } from '@kchs/i18n'
import type { ProcessPreview } from '@kchs/process'
import {
  Avatar,
  Badge,
  Button,
  Callout,
  EmptyState,
  Field,
  Input,
  ObjectIcon,
  SearchInput,
  Switch,
  useDebouncedValue,
} from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Eye } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { type PickedUser, UserPicker, UsersPicker } from '~/features/tasks/user-picker.js'
import { ApiError, http } from '~/shared/api/client.js'
import { objectListQuery } from '~/shared/api/queries.js'
import { useDesigner, useStepTitle } from './context.js'

type Values = Record<string, unknown>

/**
 * Предпросмотр «кто будет назначен» (08-documents.md §4, ADR-0079): пример
 * объекта, значения переменных и выбор инициатора — сервер считает назначенных
 * каждого шага, сроки «если начать сейчас» и сработавшие условия запуска.
 */
export function PreviewPanel() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const titleOf = useStepTitle()
  const { definition } = useDesigner()
  const [object, setObject] = useState<ObjectSummary | null>(null)
  const [values, setValues] = useState<Values>({})
  const [people, setPeople] = useState<Record<string, PickedUser[]>>({})
  const [chosen, setChosen] = useState<Record<string, PickedUser[]>>({})
  const chooseSteps = Object.entries(definition.steps).filter(
    ([, step]) => 'assignees' in step && (step.assignees ?? []).includes('chosen_by_initiator'),
  )
  const preview = useMutation({
    mutationFn: (objectId: string) =>
      http.post<ProcessPreview>('/process-definitions/preview', {
        definition,
        objectId,
        variables: {
          ...values,
          ...Object.fromEntries(
            Object.entries(people).map(([name, list]) => [
              name,
              definition.variables[name]?.type === 'user'
                ? (list[0]?.id ?? null)
                : list.map((item) => item.id),
            ]),
          ),
        },
        assignees: Object.fromEntries(
          Object.entries(chosen).map(([key, list]) => [key, list.map((item) => item.id)]),
        ),
      }),
  })
  const result = preview.data

  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-xs text-fg-muted">{t('processDesigner.preview.hint')}</p>
      <ObjectChooser objectType={definition.objectType} value={object} onChange={setObject} />
      {Object.entries(definition.variables).map(([name, variable]) => {
        const label = localizedText(variable.label, locale)
        switch (variable.type) {
          case 'user':
            return (
              <Field key={name} label={label}>
                <UserPicker
                  label={label}
                  value={people[name]?.[0] ?? null}
                  onChange={(user) =>
                    setPeople((current) => ({ ...current, [name]: user ? [user] : [] }))
                  }
                />
              </Field>
            )
          case 'users':
            return (
              <Field key={name} label={label}>
                <UsersPicker
                  label={label}
                  value={people[name] ?? []}
                  onChange={(users) => setPeople((current) => ({ ...current, [name]: users }))}
                />
              </Field>
            )
          case 'boolean':
            return (
              <Switch
                key={name}
                label={label}
                checked={values[name] === true}
                onCheckedChange={(checked) =>
                  setValues((current) => ({ ...current, [name]: checked }))
                }
              />
            )
          default:
            return (
              <VariableInput
                key={name}
                label={label}
                type={variable.type}
                value={values[name]}
                onChange={(value) => setValues((current) => ({ ...current, [name]: value }))}
              />
            )
        }
      })}
      {chooseSteps.map(([key, step]) => {
        const label = t('processDesigner.preview.chosen', { step: titleOf(key, step) })
        return (
          <Field key={key} label={label}>
            <UsersPicker
              label={label}
              value={chosen[key] ?? []}
              onChange={(users) => setChosen((current) => ({ ...current, [key]: users }))}
            />
          </Field>
        )
      })}
      <div>
        <Button
          variant="primary"
          size="sm"
          disabled={!object}
          loading={preview.isPending}
          onClick={() => object && preview.mutate(object.id)}
        >
          <Eye className="size-3.5" />
          {t('processDesigner.preview.run')}
        </Button>
      </div>
      {preview.error ? (
        <Callout tone="danger">
          {preview.error instanceof ApiError ? preview.error.message : t('errors.unknown')}
        </Callout>
      ) : null}
      {result ? (
        <div className="flex flex-col gap-3">
          {result.conditions.map((condition) => (
            <p key={condition.key} className="text-xs text-fg-secondary">
              {condition.matched
                ? t('processDesigner.preview.conditionMatched', {
                    n: condition.index + 1,
                    step: condition.key,
                  })
                : t('processDesigner.preview.conditionSkipped', { n: condition.index + 1 })}
            </p>
          ))}
          <ol aria-label={t('processDesigner.preview.steps')} className="flex flex-col gap-2">
            {result.steps.map((step) => (
              <li key={step.key} className="rounded-md border border-line bg-surface p-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-fg">
                    {step.name
                      ? localizedText(step.name, locale)
                      : t(`processDesigner.types.${step.type}`)}
                  </span>
                  <code className="font-mono text-xs text-fg-muted">{step.key}</code>
                  {step.inserted ? (
                    <Badge tone="accent" size="sm">
                      {t('processDesigner.preview.inserted')}
                    </Badge>
                  ) : null}
                </div>
                {step.assignees.length > 0 ? (
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {step.assignees.map((assignee) => (
                      <li
                        key={assignee.user.id}
                        className="flex items-center gap-1.5 rounded-xs bg-surface-2 px-1.5 py-0.5 text-xs text-fg"
                        title={assignee.source}
                      >
                        <Avatar
                          name={assignee.user.displayName}
                          src={assignee.user.avatarUrl}
                          size="xs"
                        />
                        {assignee.user.displayName}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-fg-muted">
                    {t('processDesigner.preview.nobody')}
                  </p>
                )}
                {step.dueAt ? (
                  <p className="mt-1 text-xs text-fg-muted">
                    {t('processDesigner.preview.due', {
                      date: formatDateTime(step.dueAt, { locale }),
                    })}
                  </p>
                ) : null}
                {step.issues.map((issue) => (
                  <p key={`${issue.expression}:${issue.code}`} className="mt-1 text-xs text-danger">
                    {issue.expression}: {issue.message}
                  </p>
                ))}
              </li>
            ))}
          </ol>
        </div>
      ) : object ? null : (
        <EmptyState
          compact
          icon={<Eye className="size-5" />}
          title={t('processDesigner.preview.empty')}
        />
      )}
    </div>
  )
}

function VariableInput({
  label,
  type,
  value,
  onChange,
}: {
  label: string
  type: string
  value: unknown
  onChange: (value: unknown) => void
}) {
  const id = useId()
  return (
    <Field label={label} htmlFor={id}>
      <Input
        id={id}
        type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(event) => {
          const raw = event.target.value
          if (raw === '') return onChange(undefined)
          onChange(type === 'number' ? Number(raw) : raw)
        }}
      />
    </Field>
  )
}

/** Пример объекта типа маршрута: недавние и поиск по названию. */
function ObjectChooser({
  objectType,
  value,
  onChange,
}: {
  objectType: string
  value: ObjectSummary | null
  onChange: (object: ObjectSummary | null) => void
}) {
  const t = useT()
  const listId = useId()
  const [search, setSearch] = useState('')
  const q = useDebouncedValue(search.trim(), 250)
  const { data, isFetching } = useQuery({
    ...objectListQuery({ types: objectType, ...(q ? { q } : {}), limit: 8 }),
    enabled: !value,
  })
  const label = t('processDesigner.preview.object')
  if (value) {
    return (
      <Field label={label}>
        <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-2">
          <ObjectIcon type={value.type} className="size-4 text-fg-muted" />
          <span className="min-w-0 flex-1 truncate text-sm text-fg">{value.title}</span>
          <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
            {t('processDesigner.preview.change')}
          </Button>
        </div>
      </Field>
    )
  }
  const items = data?.items ?? []
  return (
    <Field label={label}>
      <div className="flex flex-col gap-1.5">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder={t('processDesigner.preview.objectPlaceholder')}
          aria-label={label}
          aria-controls={listId}
        />
        <ul
          id={listId}
          aria-label={label}
          className="max-h-56 overflow-y-auto rounded-md border border-line p-1"
        >
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onChange(item)}
                className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left text-sm hover:bg-surface-3"
              >
                <ObjectIcon type={item.type} className="size-4 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
              </button>
            </li>
          ))}
          {!isFetching && items.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-fg-muted">
              {t('processDesigner.preview.noObjects')}
            </li>
          ) : null}
        </ul>
      </div>
    </Field>
  )
}
