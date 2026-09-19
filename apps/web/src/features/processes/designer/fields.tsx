import {
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@kchs/ui'
import { useEffect, useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useDesigner, useStepTitle } from './context.js'

/** Значение «не выбрано» для Select: пустая строка в Radix недопустима. */
export const NONE = '__none'

type LangValue = { ru: string; tg?: string; en?: string }

/** Название на трёх языках: пустое — `undefined` (показывается название типа). */
export function LangFields({
  value,
  onChange,
  label,
  required = false,
}: {
  value: LangValue | undefined
  onChange: (next: LangValue | undefined) => void
  label: string
  required?: boolean
}) {
  const t = useT()
  const ruId = useId()
  const enId = useId()
  const tgId = useId()
  const set = (locale: 'ru' | 'en' | 'tg', text: string) => {
    const next: LangValue = { ru: value?.ru ?? '', ...value, [locale]: text }
    if (!next.en) delete next.en
    if (!next.tg) delete next.tg
    onChange(!required && !next.ru && !next.en && !next.tg ? undefined : next)
  }
  const { readOnly } = useDesigner()
  return (
    <div className="flex flex-col gap-2">
      <Field label={label} htmlFor={ruId} required={required}>
        <Input
          id={ruId}
          value={value?.ru ?? ''}
          readOnly={readOnly}
          onChange={(event) => set('ru', event.target.value)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('processDesigner.fields.english')} htmlFor={enId}>
          <Input
            id={enId}
            value={value?.en ?? ''}
            readOnly={readOnly}
            onChange={(event) => set('en', event.target.value)}
          />
        </Field>
        <Field label={t('processDesigner.fields.tajik')} htmlFor={tgId}>
          <Input
            id={tgId}
            value={value?.tg ?? ''}
            readOnly={readOnly}
            onChange={(event) => set('tg', event.target.value)}
          />
        </Field>
      </div>
    </div>
  )
}

/** Целое число или пусто (`undefined`): срок в рабочих днях, кворум. */
export function NumberInput({
  value,
  onChange,
  label,
  hint,
  min = 0,
  max = 365,
}: {
  value: number | undefined
  onChange: (next: number | undefined) => void
  label: string
  hint?: string
  min?: number
  max?: number
}) {
  const id = useId()
  const { readOnly } = useDesigner()
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value ?? ''}
        readOnly={readOnly}
        className="w-32"
        onChange={(event) => {
          const raw = event.target.value
          if (raw === '') return onChange(undefined)
          const parsed = Number.parseInt(raw, 10)
          if (Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, parsed)))
        }}
      />
    </Field>
  )
}

/** Текстовое поле с моноширинным шрифтом: выражения условий и фильтров. */
export function ExpressionInput({
  value,
  onChange,
  label,
  hint,
  multiline = false,
  placeholder,
}: {
  value: string
  onChange: (next: string) => void
  label: string
  hint?: string
  multiline?: boolean
  placeholder?: string
}) {
  const id = useId()
  const { readOnly } = useDesigner()
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      {multiline ? (
        <Textarea
          id={id}
          value={value}
          rows={2}
          readOnly={readOnly}
          placeholder={placeholder}
          className="font-mono text-xs"
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          value={value}
          readOnly={readOnly}
          placeholder={placeholder}
          className="font-mono text-xs"
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  )
}

/**
 * JSON-значение (параметры шага, значение поля): текст правится свободно,
 * в определение попадает только разобранный JSON.
 */
export function JsonInput({
  value,
  onChange,
  label,
  objectOnly = false,
}: {
  value: unknown
  onChange: (next: unknown) => void
  label: string
  objectOnly?: boolean
}) {
  const t = useT()
  const id = useId()
  const { readOnly } = useDesigner()
  const serialized = JSON.stringify(value ?? (objectOnly ? {} : null), null, 2)
  const [text, setText] = useState(serialized)
  const [error, setError] = useState<string | null>(null)
  // Внешняя правка (JSON маршрута, другой шаг) заменяет текст поля
  useEffect(() => {
    setText(serialized)
    setError(null)
  }, [serialized])
  return (
    <Field label={label} error={error ?? undefined} htmlFor={id}>
      <Textarea
        id={id}
        value={text}
        rows={3}
        readOnly={readOnly}
        className="font-mono text-xs"
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          try {
            const parsed: unknown = JSON.parse(text)
            if (
              objectOnly &&
              (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            ) {
              setError(t('processDesigner.fields.jsonObject'))
              return
            }
            setError(null)
            if (JSON.stringify(parsed) !== JSON.stringify(value)) onChange(parsed)
          } catch {
            setError(t('processDesigner.fields.jsonInvalid'))
          }
        }}
      />
    </Field>
  )
}

/** Выбор шага верхнего уровня (переход, отклонение, ветвь условия). */
export function StepSelect({
  value,
  onChange,
  label,
  exclude,
  extra = [],
  noneLabel,
}: {
  value: string | undefined
  onChange: (next: string | undefined) => void
  label: string
  exclude?: string
  /** Особые варианты (`continue`, `end:rejected`) перед шагами. */
  extra?: Array<{ value: string; label: string }>
  /** Подпись «не задано»; без неё пустое значение не предлагается. */
  noneLabel?: string
}) {
  const id = useId()
  const titleOf = useStepTitle()
  const { definition, readOnly } = useDesigner()
  const inBranches = new Set(
    Object.values(definition.steps).flatMap((step) =>
      step.type === 'parallel' ? step.branches.flat() : [],
    ),
  )
  const keys = Object.keys(definition.steps).filter(
    (key) => key !== exclude && !inBranches.has(key),
  )
  const known = !value || keys.includes(value) || extra.some((item) => item.value === value)
  return (
    <Field label={label} htmlFor={id}>
      <Select
        value={value ?? NONE}
        disabled={readOnly}
        onValueChange={(next) => onChange(next === NONE ? undefined : next)}
      >
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {noneLabel ? <SelectItem value={NONE}>{noneLabel}</SelectItem> : null}
          {extra.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
          {known ? null : <SelectItem value={value as string}>{value}</SelectItem>}
          {keys.map((key) => (
            <SelectItem key={key} value={key}>
              {titleOf(key, definition.steps[key])} ({key})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}
