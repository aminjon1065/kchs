import type { FieldDef, FieldSchema, LangText } from '@kchs/contracts'
import {
  type FieldIssue,
  formatValue,
  isRequired,
  isVisible,
  normalizeValues,
  validateValues,
} from '@kchs/fields'
import { ChevronDown, Pencil } from 'lucide-react'
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Callout } from '../components/feedback.js'
import { useUiLocale, useUiT } from '../i18n/ui-locale.js'
import { cn } from '../lib/cn.js'
import { Button, IconButton } from '../primitives/button.js'
import {
  Checkbox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '../primitives/controls.js'
import { Field, Input, Textarea } from '../primitives/input.js'

export type FormValues = Record<string, unknown>

export interface ControlProps {
  field: FieldDef
  value: unknown
  onChange: (value: unknown) => void
  id: string
  invalid: boolean
  disabled: boolean
}

export interface SchemaFormProps {
  schema: Pick<FieldSchema, 'fields'> & Partial<Pick<FieldSchema, 'groups' | 'columns'>>
  values: FormValues
  onChange: (values: FormValues) => void
  /** Отправка формы: вызывается только с корректными значениями. */
  onSubmit?: (values: FormValues) => void | Promise<void>
  /**
   * Автосохранение черновика: корректные значения уходят через `delayMs`
   * после последней правки (карточки документов и задач).
   */
  autosave?: { delayMs?: number; onSave: (values: FormValues) => Promise<void> }
  /** Контролы, которым нужны данные приложения: люди, объекты, территории, файлы, геометрия. */
  renderControl?: (props: ControlProps) => ReactNode | undefined
  /** Варианты поля, зависящие от других значений (район зависит от области). */
  optionsFor?: (
    field: FieldDef,
    values: FormValues,
  ) => Array<{ value: string; label: string }> | undefined
  /** Ошибки сервера по ключам полей. */
  serverErrors?: Record<string, string>
  readOnly?: boolean
  submitLabel?: string
  /** Сообщает о несохранённых правках — для подтверждения ухода со вкладки. */
  onDirtyChange?: (dirty: boolean) => void
  className?: string
}

const WIDE = new Set(['long_text', 'json', 'multi_select', 'geometry'])
const COMPUTED = new Set(['formula', 'lookup', 'rollup'])

function labelOf(label: LangText, locale: 'ru' | 'tg' | 'en'): string {
  return label[locale] ?? label.ru
}

/**
 * Форма из схемы полей (03-ui/04-interaction-patterns.md §4): компоновка
 * в 1–2 колонки, свёртываемые группы, условная видимость и обязательность,
 * зависимые справочники, проверка по packages/fields с локализованными
 * сообщениями под полем и сводкой вверху, автосохранение черновика.
 * Управляемая: значения хранит вызывающий код.
 */
export function SchemaForm({
  schema,
  values,
  onChange,
  onSubmit,
  autosave,
  renderControl,
  optionsFor,
  serverErrors,
  readOnly = false,
  submitLabel,
  onDirtyChange,
  className,
}: SchemaFormProps) {
  const t = useUiT()
  const locale = useUiLocale()
  const formId = useId()
  const [issues, setIssues] = useState<FieldIssue[]>([])
  const [touched, setTouched] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [submitting, setSubmitting] = useState(false)
  const initial = useRef(values)

  const fields = useMemo(
    () => [...schema.fields].sort((a, b) => a.order - b.order),
    [schema.fields],
  )
  const visible = fields.filter((field) => isVisible(field, values))

  const dirty = JSON.stringify(values) !== JSON.stringify(initial.current)
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])

  // Автосохранение: только корректное состояние, с задержкой после последней правки
  const autosaveRef = useRef(autosave)
  autosaveRef.current = autosave
  useEffect(() => {
    const config = autosaveRef.current
    if (!config || !dirty) return
    const timer = setTimeout(() => {
      const result = validateValues(fields, values)
      if (!result.ok) return
      setSaveState('saving')
      void config
        .onSave(result.data)
        .then(() => {
          initial.current = values
          setSaveState('saved')
        })
        .catch(() => setSaveState('idle'))
    }, config.delayMs ?? 800)
    return () => clearTimeout(timer)
  }, [values, dirty, fields])

  const messageFor = (issue: FieldIssue, field: FieldDef | undefined): string => {
    const params = issue.params ?? {}
    const value = values[issue.path]
    const empty = value === null || value === undefined || value === ''
    if (empty && field && isRequired(field, values)) return t('ui.form.errors.required')
    switch (issue.code) {
      case 'too_small':
        return field && ['text', 'long_text', 'identifier'].includes(field.type)
          ? t('ui.form.errors.tooShort', { min: params.min ?? 0 })
          : t('ui.form.errors.tooSmall', { min: params.min ?? 0 })
      case 'too_big':
        return field && ['text', 'long_text', 'identifier'].includes(field.type)
          ? t('ui.form.errors.tooLong', { max: params.max ?? 0 })
          : t('ui.form.errors.tooBig', { max: params.max ?? 0 })
      case 'invalid_value':
        return t('ui.form.errors.option')
      case 'invalid_format':
        if (params.format === 'email') return t('ui.form.errors.email')
        if (params.format === 'url') return t('ui.form.errors.url')
        if (params.format === 'regex') return t('ui.form.errors.pattern')
        return t('ui.form.errors.date')
      case 'invalid_type':
        if (field?.type === 'integer') return t('ui.form.errors.integer')
        if (field && ['number', 'decimal', 'money', 'percent', 'duration'].includes(field.type)) {
          return t('ui.form.errors.number')
        }
        return t('ui.form.errors.invalid')
      default:
        return t('ui.form.errors.invalid')
    }
  }

  const errorFor = (key: string): string | undefined => {
    if (serverErrors?.[key]) return serverErrors[key]
    if (!touched) return undefined
    const issue = issues.find((item) => item.path === key)
    return issue
      ? messageFor(
          issue,
          fields.find((f) => f.key === key),
        )
      : undefined
  }

  const setValue = (key: string, value: unknown) => {
    const next = { ...values, [key]: value }
    onChange(next)
    if (touched) {
      const result = validateValues(fields, next)
      setIssues(result.ok ? [] : result.issues)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    const result = validateValues(fields, values)
    if (!result.ok) {
      setIssues(result.issues)
      document.getElementById(`${formId}-${result.issues[0]?.path}`)?.focus()
      return
    }
    setIssues([])
    if (!onSubmit) return
    setSubmitting(true)
    try {
      await onSubmit(result.data)
      initial.current = values
    } finally {
      setSubmitting(false)
    }
  }

  // Группы в порядке схемы; поля без группы — первыми
  const groups = schema.groups ?? []
  const byGroup = new Map<string, FieldDef[]>()
  for (const field of visible) {
    const key = field.group ?? ''
    byGroup.set(key, [...(byGroup.get(key) ?? []), field])
  }
  const orderedGroups = [
    ...(byGroup.has('') ? [{ key: '', label: null, collapsed: false }] : []),
    ...groups
      .filter((group) => byGroup.has(group.key))
      .map((group) => ({ ...group, label: labelOf(group.label, locale) })),
    ...[...byGroup.keys()]
      .filter((key) => key && !groups.some((group) => group.key === key))
      .map((key) => ({ key, label: key, collapsed: false })),
  ]

  const columns = schema.columns ?? 2
  const issueCount = touched ? issues.length : 0

  const renderField = (field: FieldDef) => {
    const id = `${formId}-${field.key}`
    const error = errorFor(field.key)
    const disabled = readOnly || field.readOnly || COMPUTED.has(field.type)
    const control: ControlProps = {
      field,
      value: values[field.key],
      onChange: (value) => setValue(field.key, value),
      id,
      invalid: Boolean(error),
      disabled,
    }
    return (
      <Field
        key={field.key}
        label={labelOf(field.label, locale)}
        htmlFor={id}
        required={isRequired(field, values)}
        error={error}
        hint={COMPUTED.has(field.type) ? t('ui.form.computed') : field.description}
        className={cn(columns === 2 && WIDE.has(field.type) && 'md:col-span-2')}
      >
        {renderControl?.(control) ?? (
          <DefaultControl {...control} options={optionsFor?.(field, values)} locale={locale} />
        )}
      </Field>
    )
  }

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      className={cn('flex flex-col gap-4', className)}
    >
      {issueCount > 0 ? (
        <Callout tone="danger">{t('ui.form.summary', { count: issueCount })}</Callout>
      ) : null}
      {orderedGroups.map((group) => (
        <FormGroup key={group.key || 'main'} title={group.label} defaultCollapsed={group.collapsed}>
          <div className={cn('grid gap-4', columns === 2 && 'md:grid-cols-2')}>
            {(byGroup.get(group.key) ?? []).map(renderField)}
          </div>
        </FormGroup>
      ))}
      {onSubmit || autosave ? (
        <div className="flex items-center justify-end gap-3">
          {autosave ? (
            <span className="text-xs text-fg-muted" aria-live="polite">
              {saveState === 'saving'
                ? t('ui.form.saving')
                : saveState === 'saved' && !dirty
                  ? t('ui.form.saved')
                  : null}
            </span>
          ) : null}
          {onSubmit && !readOnly ? (
            <Button type="submit" variant="primary" loading={submitting}>
              {submitLabel ?? t('ui.form.submit')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </form>
  )
}

function FormGroup({
  title,
  defaultCollapsed,
  children,
}: {
  title: string | null
  defaultCollapsed: boolean
  children: ReactNode
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  if (!title) return <>{children}</>
  return (
    <section className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((current) => !current)}
        className="flex items-center gap-1.5 text-left text-2xs font-semibold uppercase tracking-wide text-fg-muted hover:text-fg"
      >
        <ChevronDown
          className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')}
          aria-hidden
        />
        {title}
      </button>
      {collapsed ? null : children}
    </section>
  )
}

function DefaultControl({
  field,
  value,
  onChange,
  id,
  invalid,
  disabled,
  options,
  locale,
}: ControlProps & {
  options?: Array<{ value: string; label: string }>
  locale: 'ru' | 'tg' | 'en'
}) {
  const t = useUiT()
  const choices =
    options ??
    field.options?.map((option) => ({ value: option.value, label: labelOf(option.label, locale) }))

  switch (field.type) {
    case 'boolean':
      return (
        <Switch
          id={id}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked)}
        />
      )
    case 'long_text':
    case 'json':
      return (
        <Textarea
          id={id}
          value={
            field.type === 'json' && value !== undefined && typeof value !== 'string'
              ? JSON.stringify(value, null, 2)
              : String(value ?? '')
          }
          disabled={disabled}
          invalid={invalid}
          placeholder={field.placeholder}
          rows={field.type === 'json' ? 6 : 4}
          onChange={(event) => onChange(event.target.value)}
        />
      )
    case 'select':
      return (
        <Select
          value={typeof value === 'string' ? value : ''}
          onValueChange={(next) => onChange(next)}
          disabled={disabled}
        >
          <SelectTrigger id={id} invalid={invalid}>
            <SelectValue placeholder={field.placeholder ?? t('ui.form.notSet')} />
          </SelectTrigger>
          <SelectContent>
            {(choices ?? []).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    case 'multi_select': {
      const selected = new Set(Array.isArray(value) ? (value as string[]) : [])
      return (
        <fieldset
          id={id}
          className="m-0 flex flex-wrap gap-x-4 gap-y-2 border-0 p-0"
          disabled={disabled}
        >
          {(choices ?? []).map((option) => (
            <Checkbox
              key={option.value}
              label={option.label}
              checked={selected.has(option.value)}
              onCheckedChange={(checked) => {
                const next = new Set(selected)
                if (checked) next.add(option.value)
                else next.delete(option.value)
                onChange([...next])
              }}
            />
          ))}
        </fieldset>
      )
    }
    case 'formula':
    case 'lookup':
    case 'rollup':
      return (
        <Input
          id={id}
          readOnly
          disabled
          value={value === null || value === undefined ? '' : formatValue(value, field, { locale })}
        />
      )
    default: {
      const inputType =
        field.type === 'integer' ||
        field.type === 'number' ||
        field.type === 'decimal' ||
        field.type === 'money' ||
        field.type === 'percent'
          ? 'number'
          : field.type === 'date'
            ? 'date'
            : field.type === 'datetime'
              ? 'datetime-local'
              : field.type === 'time'
                ? 'time'
                : field.type === 'email'
                  ? 'email'
                  : field.type === 'url'
                    ? 'url'
                    : field.type === 'phone'
                      ? 'tel'
                      : 'text'
      const shown =
        field.type === 'datetime' && typeof value === 'string' && value
          ? value.slice(0, 16)
          : String(value ?? '')
      return (
        <Input
          id={id}
          type={inputType}
          value={shown}
          disabled={disabled}
          invalid={invalid}
          placeholder={field.placeholder}
          mono={field.type === 'identifier'}
          step={field.type === 'integer' ? 1 : 'any'}
          onChange={(event) => {
            const raw = event.target.value
            // datetime-local без зоны → ISO с зоной браузера
            onChange(field.type === 'datetime' && raw ? new Date(raw).toISOString() : raw)
          }}
        />
      )
    }
  }
}

// ─── Встроенный режим: свойства объекта правятся на месте ─────────────────────

export interface InlinePropertiesProps {
  schema: Pick<FieldSchema, 'fields'>
  values: FormValues
  /** Сохранение одного поля: Enter — сохранить, Esc — отменить. */
  onCommit: (key: string, value: unknown) => Promise<void>
  renderControl?: SchemaFormProps['renderControl']
  renderValue?: (field: FieldDef, value: unknown) => ReactNode | undefined
  readOnly?: boolean
}

/** Свойства объекта в карточке и контекст-панели: клик → контрол → Enter/Esc. */
export function InlineProperties({
  schema,
  values,
  onCommit,
  renderControl,
  renderValue,
  readOnly = false,
}: InlinePropertiesProps) {
  const t = useUiT()
  const locale = useUiLocale()
  const formId = useId()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<unknown>(undefined)
  const [error, setError] = useState<string | null>(null)
  const fields = schema.fields.filter((field) => isVisible(field, values))

  const commit = async (field: FieldDef) => {
    const next = normalizeValues([field], { [field.key]: draft })
    const result = validateValues([field], { ...values, ...next })
    if (!result.ok) {
      setError(t('ui.form.errors.invalid'))
      return
    }
    await onCommit(field.key, result.data[field.key] ?? null)
    setEditing(null)
    setError(null)
  }

  const onKeyDown = (field: FieldDef) => (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setEditing(null)
      setError(null)
    } else if (event.key === 'Enter' && field.type !== 'long_text') {
      event.preventDefault()
      void commit(field)
    }
  }

  return (
    <dl className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start gap-x-3 gap-y-2 text-sm">
      {fields.map((field) => {
        const id = `${formId}-${field.key}`
        const value = values[field.key]
        const editable = !readOnly && !field.readOnly && !COMPUTED.has(field.type)
        return (
          <div key={field.key} className="contents">
            <dt className="pt-1.5 text-xs text-fg-muted">{labelOf(field.label, locale)}</dt>
            <dd className="m-0 min-w-0">
              {editing === field.key ? (
                // biome-ignore lint/a11y/noStaticElementInteractions: Enter/Esc для контрола внутри
                <div onKeyDown={onKeyDown(field)} className="flex flex-col gap-1">
                  {renderControl?.({
                    field,
                    value: draft,
                    onChange: setDraft,
                    id,
                    invalid: Boolean(error),
                    disabled: false,
                  }) ?? (
                    <DefaultControl
                      field={field}
                      value={draft}
                      onChange={setDraft}
                      id={id}
                      invalid={Boolean(error)}
                      disabled={false}
                      locale={locale}
                    />
                  )}
                  {error ? <p className="text-xs text-danger">{error}</p> : null}
                </div>
              ) : (
                <span className="group flex min-h-7 items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-fg">
                    {renderValue?.(field, value) ??
                      (value === null || value === undefined || value === '' ? (
                        <span className="text-fg-muted">{t('ui.form.notSet')}</span>
                      ) : (
                        formatValue(value, field, { locale })
                      ))}
                  </span>
                  {editable ? (
                    <IconButton
                      label={t('ui.form.edit')}
                      size="sm"
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => {
                        setDraft(value)
                        setEditing(field.key)
                        setError(null)
                      }}
                    >
                      <Pencil className="size-3" />
                    </IconButton>
                  ) : null}
                </span>
              )}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}
