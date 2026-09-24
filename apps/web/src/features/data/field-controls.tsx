import type { FieldDef, FieldOption, Locale } from '@kchs/contracts'
import { formatValue } from '@kchs/fields'
import {
  Button,
  type ControlProps,
  cn,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useDebouncedValue,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { type ReactNode, useId, useMemo, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { PrincipalLine } from '~/features/access/principal-picker.js'
import { TerritoryField } from '~/features/gis/edit/territory-field.js'
import { objectListQuery, principalRefsQuery, principalsQuery } from '~/shared/api/queries.js'
import { useFieldOptions } from './field-options.js'
import { type LookupRef, lookupLabelQuery, lookupSearchQuery } from './queries.js'

/** Значение «не выбрано» в списке объектов: пустой строки Radix Select не принимает. */
const NONE = '__none'

const isEmpty = (value: unknown) => value === null || value === undefined || value === ''

/** Ссылочные типы: люди и подразделения подписываются по справочнику принципалов. */
const PRINCIPAL_TYPES = new Set(['user', 'unit'])

/** Типы, варианты которых рисует контрол дизайн-системы: список и флажки. */
const NATIVE_CHOICE = new Set(['select', 'multi_select'])

/** Вариантов в выпадающем списке — не больше: дальше сужает поиск. */
const CHOICE_VISIBLE = 200

/**
 * Контролы полей-ссылок для `SchemaForm` и табличных сводок (ADR-0129):
 * территория — деревом справочника, сотрудник и подразделение — поиском,
 * объект — списком доступных, поле со справочником (`lookup`, любого типа) —
 * выбором из строк справочного датасета с поиском, текстовое поле с вариантами
 * — выбором, как `select`. Без них такие поля правились бы как текст с кодом
 * или идентификатором. Общие для форм сбора и карточек документов; остальные
 * типы рисует контрол дизайн-системы.
 */
export function useFieldControls(
  fields: readonly FieldDef[],
): (control: ControlProps) => ReactNode | undefined {
  const locale = useAppearance((s) => s.locale) as Locale
  const options = useFieldOptions(fields)
  return (control) => {
    const { field } = control
    if (field.type === 'territory') {
      return (
        <TerritoryField
          id={control.id}
          value={control.value}
          invalid={control.invalid}
          disabled={control.disabled}
          suggestion={null}
          auto={false}
          onChange={(value) => control.onChange(value)}
        />
      )
    }
    if (field.type === 'user' || field.type === 'unit') {
      return <PrincipalValueField kind={field.type} {...control} />
    }
    if (field.type === 'object_ref') return <ObjectRefField {...control} />
    // Справочник: значение — ключ, подпись — поле подписи справочного датасета
    // (ADR-0057); большой справочник ищется запросом, малый — по списку
    if (field.lookup) {
      return (
        <ChoiceField
          {...control}
          options={options.get(field.key) ?? []}
          lookup={field.lookup}
          locale={locale}
        />
      )
    }
    // Текстовое поле с вариантами — выбором, как у поля-списка
    if (field.options?.length && !NATIVE_CHOICE.has(field.type)) {
      return <ChoiceField {...control} options={field.options} lookup={null} locale={locale} />
    }
    return undefined
  }
}

/**
 * Выбор варианта с поиском: кнопка с подписью выбранного (подпись поля связана
 * с ней), по нажатию — поиск и список. Варианты — загруженные целиком (малый
 * справочник, варианты поля) или поиск запросом по большому справочнику.
 */
function ChoiceField({
  id,
  value,
  onChange,
  invalid,
  disabled,
  options,
  lookup,
  locale,
}: ControlProps & {
  options: readonly FieldOption[]
  lookup: LookupRef | null
  locale: Locale
}) {
  const t = useT()
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search.trim(), 200)
  const current = isEmpty(value) ? null : String(value)
  const local = options.length > 0 || lookup === null
  const labelOf = (option: FieldOption) => option.label[locale] ?? option.label.ru
  const needle = query.toLowerCase()
  const remote = useQuery({
    ...lookupSearchQuery(lookup ?? { datasetId: '', keyField: '', labelField: '' }, query),
    enabled: open && !local && lookup !== null,
  })
  const remoteLabel = useQuery({
    ...lookupLabelQuery(lookup ?? { datasetId: '', keyField: '', labelField: '' }, current ?? ''),
    enabled: !local && lookup !== null && current !== null,
  })
  const items = local
    ? (needle
        ? options.filter(
            (option) =>
              labelOf(option).toLowerCase().includes(needle) ||
              option.value.toLowerCase() === needle,
          )
        : options
      ).slice(0, CHOICE_VISIBLE)
    : (remote.data ?? [])
  const known = current ? options.find((option) => option.value === current) : undefined
  const shown = current ? (known ? labelOf(known) : (remoteLabel.data ?? current)) : null

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="secondary"
            disabled={disabled}
            aria-invalid={invalid || undefined}
            className="min-w-0 flex-1 justify-start"
          >
            <span className={cn('truncate', shown === null && 'text-fg-muted')}>
              {shown ?? t('data.fieldControls.pick')}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="flex max-h-80 w-72 flex-col gap-1.5 p-2">
          <SearchInput
            value={search}
            onValueChange={setSearch}
            aria-controls={listId}
            placeholder={t('data.fieldControls.search')}
          />
          <ul id={listId} className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0">
            {items.map((option) => (
              <li key={option.value}>
                <button
                  type="button"
                  aria-current={option.value === current || undefined}
                  onClick={() => {
                    onChange(option.value)
                    setSearch('')
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full rounded-xs px-2 py-1.5 text-left text-sm hover:bg-surface-3',
                    option.value === current ? 'bg-surface-3 font-medium text-fg' : 'text-fg',
                  )}
                >
                  {labelOf(option)}
                </button>
              </li>
            ))}
            {items.length === 0 && (local || !remote.isFetching) ? (
              <li className="px-2 py-1.5 text-sm text-fg-muted">
                {t('data.fieldControls.nothingFound')}
              </li>
            ) : null}
          </ul>
        </PopoverContent>
      </Popover>
      {current && !disabled ? (
        <IconButton
          type="button"
          size="sm"
          label={t('data.fieldControls.clear')}
          onClick={() => onChange(null)}
        >
          <X className="size-3.5" aria-hidden />
        </IconButton>
      ) : null}
    </div>
  )
}

/**
 * Подпись значения поля для просмотра (панель сдачи, таблица сводки): люди и
 * подразделения — по справочнику принципалов, территория и справочник — их
 * подписями, остальное — форматом поля.
 */
export function useFieldFormatter(
  fields: readonly FieldDef[],
  records: ReadonlyArray<Record<string, unknown>>,
): (field: FieldDef, value: unknown) => string {
  const locale = useAppearance((s) => s.locale) as Locale
  const options = useFieldOptions(fields)
  const refs = useMemo(() => {
    const keys = new Set<string>()
    for (const field of fields) {
      if (!PRINCIPAL_TYPES.has(field.type)) continue
      for (const record of records) {
        const value = record[field.key]
        if (typeof value === 'string' && value) keys.add(`${field.type}:${value}`)
      }
    }
    return [...keys].sort()
  }, [fields, records])
  const { data: named } = useQuery(principalRefsQuery(refs))
  return (field, value) => {
    if (isEmpty(value)) return ''
    if (PRINCIPAL_TYPES.has(field.type) && typeof value === 'string') {
      return named?.get(`${field.type}:${value}`)?.title ?? value
    }
    const choices = options.get(field.key)
    return formatValue(value, choices ? { ...field, options: choices } : field, { locale })
  }
}

/**
 * Сотрудник или подразделение: кнопка с именем выбранного (подпись поля
 * связана с ней), по нажатию — поиск; крестик очищает поле.
 */
function PrincipalValueField({
  kind,
  id,
  value,
  onChange,
  invalid,
  disabled,
}: ControlProps & { kind: 'user' | 'unit' }) {
  const t = useT()
  const listId = useId()
  const [editing, setEditing] = useState(false)
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search.trim(), 200)
  const current = typeof value === 'string' && value ? value : null
  const key = `${kind}:${current ?? ''}`
  const { data: refs } = useQuery(principalRefsQuery(current ? [key] : []))
  const { data: found = [], isFetching } = useQuery(principalsQuery(query, kind))

  if (current && !editing) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <Button
          id={id}
          type="button"
          variant="secondary"
          disabled={disabled}
          aria-invalid={invalid || undefined}
          className="min-w-0 flex-1 justify-start"
          onClick={() => setEditing(true)}
        >
          <span className="truncate">
            {refs?.get(key)?.title ?? t('data.fieldControls.unknown')}
          </span>
        </Button>
        {!disabled ? (
          <IconButton
            type="button"
            size="sm"
            label={t('data.fieldControls.clear')}
            onClick={() => onChange(null)}
          >
            <X className="size-3.5" aria-hidden />
          </IconButton>
        ) : null}
      </div>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <SearchInput
        id={id}
        value={search}
        onValueChange={setSearch}
        disabled={disabled}
        invalid={invalid}
        placeholder={
          kind === 'user' ? t('data.fieldControls.findUser') : t('data.fieldControls.findUnit')
        }
        aria-controls={listId}
      />
      {query ? (
        <ul id={listId} className="max-h-48 overflow-y-auto rounded-md border border-line p-1">
          {found.map((principal) => (
            <li key={principal.id}>
              <button
                type="button"
                onClick={() => {
                  onChange(principal.id)
                  setSearch('')
                  setEditing(false)
                }}
                className="flex w-full items-center rounded-xs px-2 py-1.5 text-left hover:bg-surface-3"
              >
                <PrincipalLine principal={principal} />
              </button>
            </li>
          ))}
          {!isFetching && found.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-fg-muted">
              {t('data.fieldControls.nothingFound')}
            </li>
          ) : null}
        </ul>
      ) : null}
      {editing ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="self-start"
          onClick={() => {
            setSearch('')
            setEditing(false)
          }}
        >
          {t('common.actions.cancel')}
        </Button>
      ) : null}
    </div>
  )
}

/** Объект реестра: список доступных объектов допустимых типов поля. */
function ObjectRefField({ field, id, value, onChange, invalid, disabled }: ControlProps) {
  const t = useT()
  const types = field.objectTypes?.join(',') ?? ''
  const { data } = useQuery(objectListQuery({ ...(types ? { types } : {}), limit: 100 }))
  const items = data?.items ?? []
  const current = typeof value === 'string' && value ? value : ''
  const known = !current || items.some((item) => item.id === current)
  return (
    <Select
      value={current || NONE}
      onValueChange={(next) => onChange(next === NONE ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger id={id} invalid={invalid}>
        <SelectValue placeholder={t('data.fieldControls.pick')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t('data.fieldControls.none')}</SelectItem>
        {known ? null : (
          <SelectItem value={current}>{t('data.fieldControls.otherObject')}</SelectItem>
        )}
        {items.map((item) => (
          <SelectItem key={item.id} value={item.id}>
            {item.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
