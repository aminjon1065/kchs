import type { DocumentRouteOption, DocumentRouteVariable, LangText } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import type { ProcessPreview } from '@kchs/process'
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Checkbox,
  Dialog,
  DialogContent,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { useId, useMemo, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { knownKey, STEP_TYPES } from '~/features/processes/labels.js'
import { type PickedUser, UserPicker, UsersPicker } from '~/features/tasks/user-picker.js'
import { ApiError, http } from '~/shared/api/client.js'
import { documentRoutesQuery } from '../queries.js'
import { useDocument } from './document-context.js'

function text(value: LangText | null | undefined, locale: string): string | null {
  if (!value) return null
  return (value as Record<string, string | undefined>)[locale] ?? value.ru
}

type Value = string | number | boolean | PickedUser | PickedUser[] | null

/** Значение переменной — в тело запроса: сотрудники — идентификаторами. */
function wire(value: Value): unknown {
  if (value === null || value === '') return undefined
  if (Array.isArray(value)) return value.map((item) => item.id)
  if (typeof value === 'object') return value.id
  return value
}

function VariableInput({
  variable,
  value,
  onChange,
}: {
  variable: DocumentRouteVariable
  value: Value
  onChange: (value: Value) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const id = useId()
  const label = text(variable.label, locale) ?? variable.name
  switch (variable.type) {
    case 'user':
      return (
        <Field label={label} required={variable.required}>
          <UserPicker
            value={(value as PickedUser | null) ?? null}
            onChange={onChange}
            label={label}
          />
        </Field>
      )
    case 'users':
      return (
        <Field label={label} required={variable.required}>
          <UsersPicker
            value={(value as PickedUser[] | null) ?? []}
            onChange={onChange}
            label={label}
            addLabel={t('documents.route.addPerson')}
          />
        </Field>
      )
    case 'boolean':
      return (
        <label className="flex items-center gap-2 text-sm text-fg" htmlFor={id}>
          <Checkbox
            id={id}
            checked={value === true}
            onCheckedChange={(checked) => onChange(checked === true)}
          />
          {label}
        </label>
      )
    default:
      return (
        <Field label={label} htmlFor={id} required={variable.required}>
          <Input
            id={id}
            type={
              variable.type === 'number' ? 'number' : variable.type === 'date' ? 'date' : 'text'
            }
            value={value === null ? '' : String(value)}
            onChange={(event) =>
              onChange(
                variable.type === 'number' && event.target.value !== ''
                  ? Number(event.target.value)
                  : event.target.value,
              )
            }
          />
        </Field>
      )
  }
}

/** «Кто будет назначен»: шаги маршрута на этом документе, сроки, незаполненные. */
function Preview({ preview }: { preview: ProcessPreview }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  // Возврат автору — только после замечаний: в предпросмотре его нет
  const steps = preview.steps.filter(
    (step) => step.type !== 'return' && STEP_TYPES.includes(step.type as never),
  )
  return (
    <ol className="flex flex-col gap-1.5" aria-label={t('documents.route.preview')}>
      {steps.map((step) => (
        <li
          key={step.key}
          className="flex flex-col gap-1 rounded-md border border-line bg-surface px-2.5 py-2"
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
              {text(step.name, locale) ??
                t(`processes.types.${knownKey(step.type, STEP_TYPES, 'call')}`)}
            </span>
            {step.dueAt ? (
              <span className="shrink-0 text-2xs text-fg-muted">
                {t('documents.route.dueShort', { date: formatDateTime(step.dueAt, { locale }) })}
              </span>
            ) : null}
          </div>
          {step.assignees.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {step.assignees.map((item) => (
                <span key={item.user.id} className="flex items-center gap-1 text-xs text-fg">
                  <Avatar name={item.user.displayName} src={item.user.avatarUrl} size="sm" />
                  {item.user.displayName}
                </span>
              ))}
            </div>
          ) : step.type === 'register' || step.type === 'notify' ? (
            <span className="text-xs text-fg-muted">{t('documents.route.automatic')}</span>
          ) : (
            <Badge tone="warning" size="sm">
              {t('documents.route.previewEmpty')}
            </Badge>
          )}
        </li>
      ))}
    </ol>
  )
}

/**
 * «Отправить на согласование» (08-documents.md §4, ADR-0083): маршрут типа по
 * умолчанию или другой опубликованный, выбор согласующих там, где их выбирает
 * инициатор, параметры маршрута и предпросмотр «кто будет назначен».
 */
export function RouteStartDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const { document, refresh, openSection } = useDocument()
  const routeId = useId()
  const { data: options, isLoading } = useQuery(documentRoutesQuery(document.id))
  const [key, setKey] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Record<string, PickedUser[]>>({})
  const [variables, setVariables] = useState<Record<string, Value>>({})

  const route: DocumentRouteOption | undefined =
    options?.items.find((item) => item.key === key) ?? options?.items[0]
  const body = useMemo(
    () =>
      route
        ? {
            definitionKey: route.key,
            variables: Object.fromEntries(
              Object.entries(variables)
                .map(([name, value]) => [name, wire(value)] as const)
                .filter(([, value]) => value !== undefined),
            ),
            assignees: Object.fromEntries(
              Object.entries(chosen)
                .filter(([, users]) => users.length > 0)
                .map(([step, users]) => [step, users.map((user) => user.id)]),
            ),
          }
        : null,
    [route, variables, chosen],
  )
  const debounced = useDebouncedValue(body, 300)
  const preview = useQuery({
    queryKey: ['object', document.id, 'route-preview', debounced],
    queryFn: () => http.post<ProcessPreview>(`/documents/${document.id}/routes/preview`, debounced),
    enabled: Boolean(debounced) && options?.blocker !== 'access',
    placeholderData: keepPreviousData,
  })

  const start = useMutation({
    mutationFn: () => http.post<{ id: string }>(`/documents/${document.id}/routes`, body),
    onSuccess: () => {
      toast.show({ title: t('documents.route.started'), tone: 'success' })
      refresh()
      openSection('route')
      onClose()
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const missingChoice = route?.choices.some(
    (choice) => choice.required && !(chosen[choice.stepKey]?.length ?? 0),
  )
  const missingVariable = route?.variables.some(
    (variable) => variable.required && wire(variables[variable.name] ?? null) === undefined,
  )
  const blocker = options?.blocker ?? null
  const ready = Boolean(route) && !blocker && !missingChoice && !missingVariable

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('documents.route.startTitle')}
        description={document.subject || t('documents.draft')}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!ready}
              loading={start.isPending}
              onClick={() => start.mutate()}
            >
              {t('documents.route.start')}
            </Button>
          </>
        }
      >
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : !options?.items.length ? (
          <Callout tone="warning">{t('documents.route.noRoutes')}</Callout>
        ) : (
          <div className="flex flex-col gap-4">
            {blocker ? (
              <Callout tone={blocker === 'no_version' ? 'warning' : 'info'}>
                {t(`documents.route.blocked.${blocker}`)}
              </Callout>
            ) : null}
            <Field label={t('documents.route.routeLabel')} htmlFor={routeId}>
              <Select
                value={route?.key ?? ''}
                onValueChange={(value) => {
                  setKey(value)
                  setChosen({})
                  setVariables({})
                }}
              >
                <SelectTrigger id={routeId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.items.map((item) => (
                    <SelectItem key={item.key} value={item.key}>
                      {text(item.name, locale) ?? item.key}
                      {item.isDefault ? ` · ${t('documents.route.defaultRoute')}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {route?.description ? (
              <p className="text-sm text-fg-secondary">{text(route.description, locale)}</p>
            ) : null}
            {route?.choices.map((choice) => {
              const name =
                text(choice.name, locale) ??
                t(`processes.types.${knownKey(choice.type, STEP_TYPES, 'approval')}`)
              return (
                <Field
                  key={choice.stepKey}
                  label={t('documents.route.choose', { step: name })}
                  required={choice.required}
                >
                  <UsersPicker
                    value={chosen[choice.stepKey] ?? []}
                    onChange={(users) =>
                      setChosen((current) => ({ ...current, [choice.stepKey]: users }))
                    }
                    label={name}
                    addLabel={t('documents.route.addPerson')}
                  />
                </Field>
              )
            })}
            {route && route.variables.length > 0 ? (
              <section className="flex flex-col gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  {t('documents.route.variables')}
                </h3>
                {route.variables.map((variable) => (
                  <VariableInput
                    key={variable.name}
                    variable={variable}
                    value={variables[variable.name] ?? null}
                    onChange={(value) =>
                      setVariables((current) => ({ ...current, [variable.name]: value }))
                    }
                  />
                ))}
              </section>
            ) : null}
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                {t('documents.route.preview')}
              </h3>
              {preview.data ? (
                <Preview preview={preview.data} />
              ) : (
                <Skeleton className="h-24 w-full" />
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
