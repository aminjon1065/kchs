import type { DatasetField, FieldOption, LayerRecord, LayerStyle, Locale } from '@kchs/contracts'
import { type FieldRole, fieldsFor, type MapTheme, type StyleWarning } from '@kchs/map-style'
import {
  Badge,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  cn,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kchs/ui'
import { TriangleAlert } from 'lucide-react'
import { createContext, type ReactNode, useContext, useEffect, useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { fieldLabel } from '../../data/field-types.js'
import { warningsAt } from './model.js'

/** Всё, что нужно разделам формы стиля: рабочая копия, поля датасета, тема, замечания. */
export interface StyleEditorContextValue {
  layer: LayerRecord
  style: LayerStyle
  /** Правка рабочей копии: функция получает последнюю версию (и после ожидания запроса). */
  update: (change: (style: LayerStyle) => LayerStyle) => void
  fields: readonly DatasetField[]
  /** Варианты значений полей: выбор, справочники, территории — подписи категорий. */
  options: ReadonlyMap<string, readonly FieldOption[]>
  theme: MapTheme | null
  warnings: readonly StyleWarning[]
  locale: Locale
}

const StyleEditorContext = createContext<StyleEditorContextValue | null>(null)

export const StyleEditorProvider = StyleEditorContext.Provider

export function useStyleEditor(): StyleEditorContextValue {
  const value = useContext(StyleEditorContext)
  if (!value) throw new Error('useStyleEditor outside StyleEditor')
  return value
}

/** Подпись поля датасета по ключу (нет в схеме — ключ). */
export function useFieldName(): (key: string) => string {
  const { fields, locale } = useStyleEditor()
  return (key) => {
    const field = fields.find((item) => item.key === key)
    return field ? fieldLabel(field, locale) : key
  }
}

/** Замечания компилятора текстом: что не так и с каким полем. */
export function WarningList({ warnings }: { warnings: readonly StyleWarning[] }) {
  const t = useT()
  if (warnings.length === 0) return null
  return (
    <ul className="flex flex-col gap-0.5">
      {warnings.map((warning) => (
        <li
          key={`${warning.code}:${warning.path}`}
          className="flex items-start gap-1.5 text-xs text-warning"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{t(`gis.style.warnings.${warning.code}`, { detail: warning.detail ?? '' })}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Строка формы: подпись над элементом и замечания компилятора по пути стиля
 * под ним. `id` связывает подпись с элементом.
 */
export function EditorRow({
  label,
  id,
  path,
  exact,
  hint,
  className,
  children,
}: {
  label: ReactNode
  id?: string
  /** Путь в LayerStyle, замечания которого показать под элементом. */
  path?: string
  exact?: boolean
  hint?: ReactNode
  className?: string
  children: ReactNode
}) {
  const { warnings } = useStyleEditor()
  const shown = path ? warningsAt(warnings, path, { exact }) : []
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <label htmlFor={id} className="text-xs font-medium text-fg-secondary">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
      <WarningList warnings={shown} />
    </div>
  )
}

/**
 * Раздел формы стиля: сворачивается; число замечаний компилятора в разделе —
 * рядом с заголовком, чтобы свёрнутый раздел не прятал проблему.
 */
export function EditorSection({
  title,
  paths,
  defaultOpen = false,
  action,
  children,
}: {
  title: string
  /** Пути LayerStyle раздела — для счётчика замечаний. */
  paths: readonly string[]
  defaultOpen?: boolean
  action?: ReactNode
  children: ReactNode
}) {
  const t = useT()
  const { warnings } = useStyleEditor()
  const count = warnings.filter((warning) =>
    paths.some((path) => warning.path === path || warning.path.startsWith(`${path}.`)),
  ).length
  return (
    <Collapsible defaultOpen={defaultOpen || count > 0} className="border-b border-line py-1">
      <div className="flex items-center gap-2 pr-2">
        <CollapsibleTrigger className="min-w-0 flex-1 py-1.5">
          <span className="truncate">{title}</span>
        </CollapsibleTrigger>
        {count > 0 ? (
          <Badge size="sm" tone="warning">
            {t('gis.style.warningCount', { n: count })}
          </Badge>
        ) : null}
        {action}
      </div>
      <CollapsibleContent className="flex flex-col gap-3 px-1.5 pt-1 pb-3">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

const NONE = '__none__'

/** Выбор поля датасета для роли в стиле (категории, числа, время, подпись). */
export function FieldPicker({
  id,
  fieldRole,
  value,
  onChange,
  allowNone = false,
  noneLabel,
  exclude = [],
  invalid,
}: {
  id?: string
  /** Какие поля подходят: категории, числа, время или подпись. */
  fieldRole: FieldRole
  value: string | null
  onChange: (key: string | null) => void
  allowNone?: boolean
  noneLabel?: string
  exclude?: readonly string[]
  invalid?: boolean
}) {
  const t = useT()
  const { fields, locale, layer } = useStyleEditor()
  const candidates = fieldsFor(fields, fieldRole).filter(
    (field) => field.key !== layer.geometryField && !exclude.includes(field.key),
  )
  const known = value === null || candidates.some((field) => field.key === value)
  return (
    <Select value={value ?? NONE} onValueChange={(next) => onChange(next === NONE ? null : next)}>
      <SelectTrigger id={id} invalid={invalid || !known}>
        <SelectValue placeholder={t('gis.style.field.choose')} />
      </SelectTrigger>
      <SelectContent>
        {allowNone ? (
          <SelectItem value={NONE}>{noneLabel ?? t('gis.style.field.none')}</SelectItem>
        ) : null}
        {!known && value ? <SelectItem value={value}>{value}</SelectItem> : null}
        {candidates.map((field) => (
          <SelectItem key={field.key} value={field.key}>
            {fieldLabel(field, locale)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

const format = (value: number) => String(Number(value.toFixed(4)))

/**
 * Число с единицей: правка применяется, как только введено допустимое число,
 * при уходе из поля — возвращается к последнему применённому. `scale` —
 * множитель показа: прозрачность 0…1 правится в процентах.
 */
export function NumberField({
  id,
  value,
  onChange,
  min,
  max,
  step = 1,
  scale = 1,
  suffix,
  placeholder,
  optional = false,
  className,
  'aria-label': ariaLabel,
}: {
  id?: string
  value: number | null
  onChange: (value: number | null) => void
  min: number
  max: number
  step?: number
  scale?: number
  suffix?: ReactNode
  placeholder?: string
  /** Пустое поле — значение не задано (например, размер категории — как у слоя). */
  optional?: boolean
  className?: string
  'aria-label'?: string
}) {
  const shown = value === null ? '' : format(value * scale)
  const [text, setText] = useState(shown)
  const generated = useId()
  // Значение сменилось снаружи (пресет, отмена) — показать его
  useEffect(() => setText(shown), [shown])
  const commit = (raw: string) => {
    if (raw.trim() === '') {
      if (optional) onChange(null)
      return
    }
    const next = Number(raw.replace(',', '.'))
    if (!Number.isFinite(next)) return
    if (next < min * scale || next > max * scale) return
    onChange(next / scale)
  }
  return (
    <Input
      id={id ?? generated}
      type="number"
      inputMode="decimal"
      value={text}
      min={min * scale}
      max={max * scale}
      step={step}
      suffix={suffix}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={className}
      onChange={(event) => {
        setText(event.target.value)
        commit(event.target.value)
      }}
      onBlur={() => setText(shown)}
    />
  )
}

/** Выбор из списка значений с подписями (подписи — из словаря у вызывающего). */
export function ChoiceSelect<T extends string>({
  id,
  value,
  onChange,
  choices,
  label,
  disabled,
}: {
  id?: string
  value: T
  onChange: (value: T) => void
  choices: readonly T[]
  label: (value: T) => string
  disabled?: (value: T) => boolean
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {choices.map((choice) => (
          <SelectItem key={choice} value={choice} disabled={disabled?.(choice)}>
            {label(choice)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
