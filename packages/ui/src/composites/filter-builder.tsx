import type { FieldType, FilterCondition, FilterNode, FilterOperator } from '@kchs/contracts'
import { formatDate, formatNumber, needsValue, operatorsFor } from '@kchs/fields'
import { ListFilter, Plus, Trash2, X } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
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
} from '../primitives/controls.js'
import { Input } from '../primitives/input.js'
import { Popover, PopoverContent, PopoverTrigger } from '../primitives/overlays.js'

export interface FilterField {
  key: string
  label: string
  type: FieldType
  options?: Array<{ value: string; label: string }>
}

export interface ValueEditorProps {
  field: FilterField
  op: FilterOperator
  value: unknown
  onChange: (value: unknown) => void
}

export interface FilterBuilderProps {
  fields: FilterField[]
  value: FilterNode | null
  onChange: (value: FilterNode | null) => void
  /** Редактор значений, которым нужны данные приложения (люди, объекты, территории). */
  renderValue?: (props: ValueEditorProps) => ReactNode | undefined
  /** Подпись значения в чипе для таких полей (имена людей вместо идентификаторов). */
  describeValue?: (field: FilterField, op: FilterOperator, value: unknown) => string | undefined
  className?: string
}

type RelativePreset = {
  key: string
  unit: 'day' | 'week' | 'month' | 'quarter' | 'year'
  from: number
  to: number
}

const PRESETS: RelativePreset[] = [
  { key: 'today', unit: 'day', from: 0, to: 0 },
  { key: 'yesterday', unit: 'day', from: -1, to: -1 },
  { key: 'thisWeek', unit: 'week', from: 0, to: 0 },
  { key: 'last7', unit: 'day', from: -6, to: 0 },
  { key: 'last30', unit: 'day', from: -29, to: 0 },
  { key: 'thisMonth', unit: 'month', from: 0, to: 0 },
  { key: 'lastMonth', unit: 'month', from: -1, to: -1 },
  { key: 'thisQuarter', unit: 'quarter', from: 0, to: 0 },
  { key: 'thisYear', unit: 'year', from: 0, to: 0 },
  { key: 'last12Months', unit: 'month', from: -11, to: 0 },
]

const NUMERIC: FieldType[] = [
  'integer',
  'number',
  'decimal',
  'money',
  'percent',
  'duration',
  'formula',
  'rollup',
]
const DATE_TYPES: FieldType[] = ['date', 'datetime']
const CHOICE: FieldType[] = ['select', 'multi_select', 'lookup']

/** Верхний уровень фильтра — «И» из условий и групп «или» (вложенность 2 уровня). */
type Item = FilterCondition | { or: FilterNode[] }

function toItems(value: FilterNode | null): Item[] {
  if (!value) return []
  if ('and' in value)
    return value.and.filter((node): node is Item => 'field' in node || 'or' in node)
  if ('field' in value || 'or' in value) return [value]
  return []
}

function fromItems(items: Item[]): FilterNode | null {
  if (items.length === 0) return null
  if (items.length === 1) return items[0] as FilterNode
  return { and: items }
}

function defaultValue(field: FilterField, op: FilterOperator): unknown {
  if (!needsValue(op)) return undefined
  if (op === 'relative') return { unit: 'day', from: -6, to: 0 }
  if (op === 'between') return ['', '']
  if (op === 'in' || op === 'not_in') return []
  if (field.type === 'boolean') return true
  return ''
}

function isComplete(condition: FilterCondition): boolean {
  if (!needsValue(condition.op)) return true
  const value = condition.value
  if (Array.isArray(value)) {
    return condition.op === 'between'
      ? value.length === 2 && value.every((v) => v !== '' && v !== null)
      : value.length > 0
  }
  return value !== '' && value !== undefined && value !== null
}

/**
 * Конструктор фильтра (03-ui/04-interaction-patterns.md §3): чипы условий и
 * поповер добавления «поле → условие → значение»; расширенный режим — группы
 * «или» внутри общего «и». Формат — общий фильтр contracts/field-types.md.
 */
export function FilterBuilder({
  fields,
  value,
  onChange,
  renderValue,
  describeValue,
  className,
}: FilterBuilderProps) {
  const t = useUiT()
  const [advanced, setAdvanced] = useState(false)
  const items = toItems(value)
  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields])

  const setItems = (next: Item[]) => onChange(fromItems(next))
  const hasGroups = items.some((item) => 'or' in item)

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {items.map((item, index) =>
          'or' in item ? (
            <GroupChip
              key={`g-${index}`}
              group={item}
              fields={byKey}
              describeValue={describeValue}
              onEdit={() => setAdvanced(true)}
              onRemove={() => setItems(items.filter((_, i) => i !== index))}
            />
          ) : (
            <ConditionChip
              key={`c-${index}-${item.field}`}
              condition={item}
              fields={fields}
              byKey={byKey}
              renderValue={renderValue}
              describeValue={describeValue}
              onChange={(next) => setItems(items.map((it, i) => (i === index ? next : it)))}
              onRemove={() => setItems(items.filter((_, i) => i !== index))}
            />
          ),
        )}
        <AddCondition
          fields={fields}
          renderValue={renderValue}
          onAdd={(condition) => setItems([...items, condition])}
        />
        {items.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
            {t('ui.filter.clear')}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={advanced}
          onClick={() => setAdvanced((current) => !current)}
          className="ml-auto"
        >
          {advanced ? t('ui.filter.simple') : t('ui.filter.advanced')}
        </Button>
      </div>

      {advanced || hasGroups ? (
        advanced ? (
          <AdvancedEditor
            items={items}
            fields={fields}
            renderValue={renderValue}
            onChange={setItems}
          />
        ) : null
      ) : null}
    </div>
  )
}

// ─── Чипы ───────────────────────────────────────────────────────────────────

function useDescribe(describeValue: FilterBuilderProps['describeValue']) {
  const t = useUiT()
  const locale = useUiLocale()
  return (field: FilterField | undefined, condition: FilterCondition): string => {
    const op = t(`ui.filter.ops.${condition.op}`)
    const label = field?.label ?? condition.field
    if (!needsValue(condition.op)) return `${label}: ${op}`
    const custom = field ? describeValue?.(field, condition.op, condition.value) : undefined
    const value = custom ?? formatConditionValue(field, condition, t, locale)
    return `${label} ${op} ${value}`
  }
}

function formatConditionValue(
  field: FilterField | undefined,
  condition: FilterCondition,
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: 'ru' | 'tg' | 'en',
): string {
  const one = (v: unknown): string => {
    if (v === null || v === undefined || v === '') return '—'
    if (field && DATE_TYPES.includes(field.type) && typeof v === 'string') {
      return formatDate(v, { locale })
    }
    if (field && NUMERIC.includes(field.type) && (typeof v === 'number' || typeof v === 'string')) {
      const n = Number(v)
      return Number.isFinite(n) ? formatNumber(n, {}, { locale }) : String(v)
    }
    const option = field?.options?.find((o) => o.value === v)
    return option?.label ?? String(v)
  }
  const value = condition.value
  if (condition.op === 'relative' && value && typeof value === 'object' && !Array.isArray(value)) {
    const range = value as { unit: string; from: number; to: number }
    const preset = PRESETS.find(
      (p) => p.unit === range.unit && p.from === range.from && p.to === range.to,
    )
    return preset ? t(`ui.filter.presets.${preset.key}`) : `${range.from}…${range.to} ${range.unit}`
  }
  if (Array.isArray(value)) {
    if (condition.op === 'between') return `${one(value[0])} – ${one(value[1])}`
    const shown = value.slice(0, 2).map(one).join(', ')
    return value.length > 2 ? `${shown} +${value.length - 2}` : shown
  }
  if (typeof value === 'boolean') return value ? t('ui.filter.yes') : t('ui.filter.no')
  return one(value)
}

function ConditionChip({
  condition,
  fields,
  byKey,
  renderValue,
  describeValue,
  onChange,
  onRemove,
}: {
  condition: FilterCondition
  fields: FilterField[]
  byKey: Map<string, FilterField>
  renderValue?: FilterBuilderProps['renderValue']
  describeValue?: FilterBuilderProps['describeValue']
  onChange: (condition: FilterCondition) => void
  onRemove: () => void
}) {
  const t = useUiT()
  const describe = useDescribe(describeValue)
  const [open, setOpen] = useState(false)
  const text = describe(byKey.get(condition.field), condition)
  return (
    <span className="inline-flex h-7 items-center rounded-sm border border-accent/40 bg-accent-subtle text-xs text-fg">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {/* Имя кнопки начинается с видимого текста условия: скринридер его озвучивает */}
          <button
            type="button"
            aria-label={t('ui.filter.edit', { condition: text })}
            className="max-w-72 truncate px-2 hover:text-accent"
          >
            {text}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80">
          <ConditionEditor
            fields={fields}
            initial={condition}
            renderValue={renderValue}
            onApply={(next) => {
              onChange(next)
              setOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('ui.filter.remove', { condition: text })}
        className="flex h-full items-center border-l border-accent/30 px-1.5 text-fg-muted hover:text-fg"
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  )
}

function GroupChip({
  group,
  fields,
  describeValue,
  onEdit,
  onRemove,
}: {
  group: { or: FilterNode[] }
  fields: Map<string, FilterField>
  describeValue?: FilterBuilderProps['describeValue']
  onEdit: () => void
  onRemove: () => void
}) {
  const t = useUiT()
  const describe = useDescribe(describeValue)
  const text = group.or
    .filter((node): node is FilterCondition => 'field' in node)
    .map((condition) => describe(fields.get(condition.field), condition))
    .join(` ${t('ui.filter.or')} `)
  return (
    <span className="inline-flex h-7 items-center rounded-sm border border-accent/40 bg-accent-subtle text-xs text-fg">
      <button type="button" onClick={onEdit} className="max-w-96 truncate px-2 hover:text-accent">
        ({text})
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('ui.filter.remove', { condition: `(${text})` })}
        className="flex h-full items-center border-l border-accent/30 px-1.5 text-fg-muted hover:text-fg"
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  )
}

function AddCondition({
  fields,
  renderValue,
  onAdd,
}: {
  fields: FilterField[]
  renderValue?: FilterBuilderProps['renderValue']
  onAdd: (condition: FilterCondition) => void
}) {
  const t = useUiT()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm" icon={<ListFilter className="size-3.5" />}>
          {t('ui.filter.add')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <ConditionEditor
          fields={fields}
          renderValue={renderValue}
          onApply={(condition) => {
            onAdd(condition)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

// ─── Редактор условия ───────────────────────────────────────────────────────

function ConditionEditor({
  fields,
  initial,
  renderValue,
  onApply,
}: {
  fields: FilterField[]
  initial?: FilterCondition
  renderValue?: FilterBuilderProps['renderValue']
  onApply: (condition: FilterCondition) => void
}) {
  const t = useUiT()
  const [draft, setDraft] = useState<FilterCondition | null>(initial ?? null)
  const [query, setQuery] = useState('')
  const field = draft ? fields.find((f) => f.key === draft.field) : undefined

  if (!draft || !field) {
    const matches = fields.filter((f) => f.label.toLowerCase().includes(query.trim().toLowerCase()))
    return (
      <div className="flex flex-col gap-2">
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('ui.filter.searchField')}
          aria-label={t('ui.filter.searchField')}
          onKeyDown={(event) => {
            const first = matches[0]
            if (event.key === 'Enter' && first) {
              event.preventDefault()
              const op = operatorsFor(first.type)[0] as FilterOperator
              setDraft({ field: first.key, op, value: defaultValue(first, op) })
            }
          }}
        />
        <ul className="max-h-64 overflow-y-auto" aria-label={t('ui.filter.field')}>
          {matches.map((candidate) => (
            <li key={candidate.key}>
              <button
                type="button"
                onClick={() => {
                  const op = operatorsFor(candidate.type)[0] as FilterOperator
                  setDraft({ field: candidate.key, op, value: defaultValue(candidate, op) })
                }}
                className="flex w-full items-center rounded-xs px-2 py-1.5 text-left text-sm hover:bg-surface-3 focus-visible:bg-surface-3 focus-visible:outline-none"
              >
                {candidate.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const operators = operatorsFor(field.type)
  const complete = isComplete(draft)

  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(event) => {
        event.preventDefault()
        if (complete) onApply(normalize(field, draft))
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-fg">{field.label}</span>
        {!initial ? (
          <Button variant="ghost" size="sm" type="button" onClick={() => setDraft(null)}>
            {t('ui.filter.field')}
          </Button>
        ) : null}
      </div>
      <Select
        value={draft.op}
        onValueChange={(op) =>
          setDraft({
            field: draft.field,
            op: op as FilterOperator,
            value: defaultValue(field, op as FilterOperator),
          })
        }
      >
        <SelectTrigger aria-label={t('ui.filter.operator')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {operators.map((op) => (
            <SelectItem key={op} value={op}>
              {t(`ui.filter.ops.${op}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {needsValue(draft.op) ? (
        <ValueEditor
          field={field}
          op={draft.op}
          value={draft.value}
          renderValue={renderValue}
          onChange={(next) => setDraft({ ...draft, value: next })}
        />
      ) : null}
      <Button type="submit" variant="primary" size="sm" disabled={!complete}>
        {t('ui.filter.apply')}
      </Button>
    </form>
  )
}

/** Строки из полей ввода приводятся к типу поля до отправки на сервер. */
function normalize(field: FilterField, condition: FilterCondition): FilterCondition {
  const toNumber = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v)
  if (NUMERIC.includes(field.type)) {
    const value = Array.isArray(condition.value)
      ? condition.value.map(toNumber)
      : toNumber(condition.value)
    return { ...condition, value }
  }
  return condition
}

function ValueEditor({
  field,
  op,
  value,
  renderValue,
  onChange,
}: ValueEditorProps & { renderValue?: FilterBuilderProps['renderValue'] }) {
  const t = useUiT()
  const custom = renderValue?.({ field, op, value, onChange })
  if (custom !== undefined) return <>{custom}</>

  if (op === 'relative') {
    const range = (value ?? {}) as { unit?: string; from?: number; to?: number }
    const current = PRESETS.find(
      (p) => p.unit === range.unit && p.from === range.from && p.to === range.to,
    )
    return (
      <Select
        value={current?.key ?? ''}
        onValueChange={(key) => {
          const preset = PRESETS.find((p) => p.key === key)
          if (preset) onChange({ unit: preset.unit, from: preset.from, to: preset.to })
        }}
      >
        <SelectTrigger aria-label={t('ui.filter.value')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRESETS.map((preset) => (
            <SelectItem key={preset.key} value={preset.key}>
              {t(`ui.filter.presets.${preset.key}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  const inputType = NUMERIC.includes(field.type)
    ? 'number'
    : DATE_TYPES.includes(field.type)
      ? 'date'
      : 'text'

  if (op === 'between') {
    const [from, to] = Array.isArray(value) ? value : ['', '']
    return (
      <div className="flex items-center gap-2">
        <Input
          type={inputType}
          value={String(from ?? '')}
          aria-label={t('ui.filter.from')}
          onChange={(event) => onChange([event.target.value, to])}
        />
        <span className="text-xs text-fg-muted">–</span>
        <Input
          type={inputType}
          value={String(to ?? '')}
          aria-label={t('ui.filter.to')}
          onChange={(event) => onChange([from, event.target.value])}
        />
      </div>
    )
  }

  if ((op === 'in' || op === 'not_in') && field.options && CHOICE.includes(field.type)) {
    const selected = new Set(Array.isArray(value) ? (value as string[]) : [])
    return (
      <ul
        className="flex max-h-56 flex-col gap-1.5 overflow-y-auto"
        aria-label={t('ui.filter.value')}
      >
        {field.options.map((option) => (
          <li key={option.value}>
            <Checkbox
              label={option.label}
              checked={selected.has(option.value)}
              onCheckedChange={(checked) => {
                const next = new Set(selected)
                if (checked) next.add(option.value)
                else next.delete(option.value)
                onChange([...next])
              }}
            />
          </li>
        ))}
      </ul>
    )
  }

  if (op === 'in' || op === 'not_in') {
    const text = Array.isArray(value) ? (value as unknown[]).join(', ') : ''
    return (
      <Input
        value={text}
        aria-label={t('ui.filter.value')}
        placeholder={t('ui.filter.listHint')}
        onChange={(event) =>
          onChange(
            event.target.value
              .split(',')
              .map((part) => part.trim())
              .filter(Boolean),
          )
        }
      />
    )
  }

  if (field.options && CHOICE.includes(field.type)) {
    return (
      <Select value={String(value ?? '')} onValueChange={(next) => onChange(next)}>
        <SelectTrigger aria-label={t('ui.filter.value')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {field.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  return (
    <Input
      autoFocus
      type={inputType}
      value={String(value ?? '')}
      aria-label={t('ui.filter.value')}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

// ─── Расширенный режим: «и» из условий и групп «или» ─────────────────────────

function AdvancedEditor({
  items,
  fields,
  renderValue,
  onChange,
}: {
  items: Item[]
  fields: FilterField[]
  renderValue?: FilterBuilderProps['renderValue']
  onChange: (items: Item[]) => void
}) {
  const t = useUiT()
  const firstField = fields[0]
  const blank = (): FilterCondition | null => {
    if (!firstField) return null
    const op = operatorsFor(firstField.type)[0] as FilterOperator
    return { field: firstField.key, op, value: defaultValue(firstField, op) }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-3">
      <span className="text-2xs font-medium uppercase tracking-wide text-fg-muted">
        {t('ui.filter.all')}
      </span>
      {items.map((item, index) =>
        'or' in item ? (
          <div
            key={`g-${index}`}
            className="flex flex-col gap-2 rounded-sm border border-line bg-surface p-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-2xs font-medium uppercase tracking-wide text-fg-muted">
                {t('ui.filter.any')}
              </span>
              <IconButton
                label={t('ui.filter.remove')}
                size="sm"
                onClick={() => onChange(items.filter((_, i) => i !== index))}
              >
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
            {item.or
              .filter((node): node is FilterCondition => 'field' in node)
              .map((condition, inner) => (
                <ConditionRow
                  key={`g-${index}-${inner}`}
                  condition={condition}
                  fields={fields}
                  renderValue={renderValue}
                  onChange={(next) =>
                    onChange(
                      items.map((it, i) =>
                        i === index
                          ? { or: item.or.map((node, j) => (j === inner ? next : node)) }
                          : it,
                      ),
                    )
                  }
                  onRemove={() => {
                    const rest = item.or.filter((_, j) => j !== inner)
                    onChange(
                      rest.length === 0
                        ? items.filter((_, i) => i !== index)
                        : items.map((it, i) => (i === index ? { or: rest } : it)),
                    )
                  }}
                />
              ))}
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus className="size-3.5" />}
              className="self-start"
              onClick={() => {
                const condition = blank()
                if (condition) {
                  onChange(
                    items.map((it, i) => (i === index ? { or: [...item.or, condition] } : it)),
                  )
                }
              }}
            >
              {t('ui.filter.addCondition')}
            </Button>
          </div>
        ) : (
          <ConditionRow
            key={`c-${index}`}
            condition={item}
            fields={fields}
            renderValue={renderValue}
            onChange={(next) => onChange(items.map((it, i) => (i === index ? next : it)))}
            onRemove={() => onChange(items.filter((_, i) => i !== index))}
          />
        ),
      )}
      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus className="size-3.5" />}
          onClick={() => {
            const condition = blank()
            if (condition) onChange([...items, condition])
          }}
        >
          {t('ui.filter.addCondition')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus className="size-3.5" />}
          onClick={() => {
            const condition = blank()
            if (condition) onChange([...items, { or: [condition] }])
          }}
        >
          {t('ui.filter.addGroup')}
        </Button>
      </div>
    </div>
  )
}

function ConditionRow({
  condition,
  fields,
  renderValue,
  onChange,
  onRemove,
}: {
  condition: FilterCondition
  fields: FilterField[]
  renderValue?: FilterBuilderProps['renderValue']
  onChange: (condition: FilterCondition) => void
  onRemove: () => void
}) {
  const t = useUiT()
  const field = fields.find((f) => f.key === condition.field)
  const operators = field ? operatorsFor(field.type) : []
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto] items-start gap-2">
      <Select
        value={condition.field}
        onValueChange={(key) => {
          const next = fields.find((f) => f.key === key)
          if (!next) return
          const op = operatorsFor(next.type)[0] as FilterOperator
          onChange({ field: key, op, value: defaultValue(next, op) })
        }}
      >
        <SelectTrigger aria-label={t('ui.filter.field')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {fields.map((f) => (
            <SelectItem key={f.key} value={f.key}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={condition.op}
        onValueChange={(op) =>
          field &&
          onChange({
            field: condition.field,
            op: op as FilterOperator,
            value: defaultValue(field, op as FilterOperator),
          })
        }
      >
        <SelectTrigger aria-label={t('ui.filter.operator')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {operators.map((op) => (
            <SelectItem key={op} value={op}>
              {t(`ui.filter.ops.${op}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="min-w-0">
        {field && needsValue(condition.op) ? (
          <ValueEditor
            field={field}
            op={condition.op}
            value={condition.value}
            renderValue={renderValue}
            onChange={(value) => onChange(normalize(field, { ...condition, value }))}
          />
        ) : null}
      </div>
      <IconButton label={t('ui.filter.remove')} size="sm" onClick={onRemove}>
        <Trash2 className="size-3.5" />
      </IconButton>
    </div>
  )
}
