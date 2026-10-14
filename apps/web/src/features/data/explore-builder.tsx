import {
  type Aggregate,
  calcApplies,
  type DatasetField,
  EXPLORE_CALCS,
  EXPLORE_TERRITORY_LEVELS,
  type ExploreCalc,
  type ExploreCompare,
  type ExploreGroup,
  type ExploreMeasure,
  type ExplorePeriod,
  type ExplorePlan,
  type ExploreTerritoryLevel,
  measureAlias,
  planColumns,
  type QueryResult,
  TIME_BUCKETS,
  type TimeBucket,
} from '@kchs/contracts'
import {
  Button,
  cn,
  DataGrid,
  type DataGridColumn,
  FilterBuilder,
  IconButton,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kchs/ui'
import { CalendarRange, Plus, X } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useTerritoryFilterEditor } from '~/entities/territory/territory-filter.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import {
  COMPARE_PRESETS,
  type ComparePreset,
  comparePeriods,
  presetOf,
  today,
} from './explore-insights.js'
import { labelOf } from './explore-labels.js'
import { useFieldOptions } from './field-options.js'
import { filterFieldsOf, NUMERIC_TYPES } from './field-types.js'

/**
 * Конструктор «Исследования» (03-screens.md §7) — шаги плана: фильтры, разрезы,
 * меры, сортировка, лимит — и показ результата. Общий для экрана «Исследование»
 * и ячеек тетради (ADR-0071): план один, запрос из него — `explorePlanSpec`.
 */

const AGGREGATES: Aggregate[] = [
  'count',
  'count_distinct',
  'sum',
  'avg',
  'min',
  'max',
  'median',
  'expr',
]
/** Поля, которые не годятся в разрез. */
const NOT_GROUPABLE = new Set<string>(['geometry', 'json', 'long_text', 'multi_select'])
const TEMPORAL = new Set<string>(['date', 'datetime'])
const NONE = '__none'

/**
 * Шаги плана: фильтры, разрезы, меры, сортировка, лимит. `compact` — узкая
 * колонка ячейки тетради: шаги в две колонки на широком экране.
 */
export function ExplorePlanEditor({
  fields,
  plan,
  onChange,
  columnLabel,
  compact = false,
  anchor = null,
}: {
  fields: readonly DatasetField[]
  plan: ExplorePlan
  onChange: (patch: Partial<ExplorePlan>) => void
  columnLabel: (name: string) => string
  compact?: boolean
  /** Последняя дата в данных: пресеты сравнения отсчитываются от неё (ADR-0217). */
  anchor?: string | null
}) {
  const t = useT()
  const locale = useLocale()
  const fieldOptions = useFieldOptions(fields)
  const territoryEditor = useTerritoryFilterEditor(
    fields.some((field) => field.type === 'territory'),
  )
  const groupable = fields.filter((field) => !NOT_GROUPABLE.has(field.type))
  const numeric = fields.filter((field) => NUMERIC_TYPES.has(field.type))
  const filterFields = filterFieldsOf(fields, locale, fieldOptions)
  const sortable = planColumns(plan)

  return (
    <div className={cn('flex flex-col gap-4', compact && 'md:grid md:grid-cols-2 md:gap-x-6')}>
      <Section title={t('data.explore.filters')}>
        <FilterBuilder
          fields={filterFields}
          value={plan.filter}
          onChange={(filter) => onChange({ filter })}
          renderValue={territoryEditor}
        />
      </Section>

      <Section
        title={t('data.explore.groups')}
        action={
          <IconButton
            label={t('data.explore.addGroup')}
            size="sm"
            disabled={groupable.length === 0}
            onClick={() => {
              const next = groupable.find(
                (field) => !plan.groups.some((group) => group.field === field.key),
              )
              if (next) {
                onChange({
                  groups: [
                    ...plan.groups,
                    { field: next.key, ...(TEMPORAL.has(next.type) ? { bucket: 'month' } : {}) },
                  ],
                })
              }
            }}
          >
            <Plus className="size-3.5" />
          </IconButton>
        }
      >
        {plan.groups.map((group, index) => (
          <GroupRow
            key={`${group.field}-${index}`}
            group={group}
            fields={groupable}
            locale={locale}
            onChange={(next) =>
              onChange({ groups: plan.groups.map((item, i) => (i === index ? next : item)) })
            }
            onRemove={() => onChange({ groups: plan.groups.filter((_, i) => i !== index) })}
          />
        ))}
      </Section>

      <Section
        title={t('data.explore.measures')}
        action={
          <IconButton
            label={t('data.explore.addMeasure')}
            size="sm"
            onClick={() =>
              onChange({
                measures: [
                  ...plan.measures,
                  numeric[0] ? { agg: 'sum', field: numeric[0].key } : { agg: 'count' },
                ],
              })
            }
          >
            <Plus className="size-3.5" />
          </IconButton>
        }
      >
        {plan.measures.map((measure, index) => (
          <MeasureRow
            key={`${measureAlias(measure)}-${index}`}
            measure={measure}
            plan={plan}
            fields={fields}
            numeric={numeric}
            locale={locale}
            onChange={(next) =>
              onChange({ measures: plan.measures.map((item, i) => (i === index ? next : item)) })
            }
            onRemove={() => onChange({ measures: plan.measures.filter((_, i) => i !== index) })}
          />
        ))}
      </Section>

      <CompareSection fields={fields} plan={plan} onChange={onChange} anchor={anchor} />

      <Section title={t('data.explore.sort')}>
        <div className="flex flex-col gap-2">
          <Select
            value={plan.sort?.field && sortable.includes(plan.sort.field) ? plan.sort.field : NONE}
            onValueChange={(field) =>
              onChange({ sort: field === NONE ? null : { field, dir: plan.sort?.dir ?? 'desc' } })
            }
          >
            <SelectTrigger aria-label={t('data.explore.sort')} className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('data.explore.sortNone')}</SelectItem>
              {sortable.map((name) => (
                <SelectItem key={name} value={name}>
                  {columnLabel(name)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {plan.sort ? (
            <SegmentedControl
              size="sm"
              aria-label={t('data.explore.sort')}
              value={plan.sort.dir}
              onValueChange={(dir) =>
                plan.sort && onChange({ sort: { field: plan.sort.field, dir } })
              }
              options={[
                { value: 'desc', label: t('data.explore.desc') },
                { value: 'asc', label: t('data.explore.asc') },
              ]}
            />
          ) : null}
        </div>
      </Section>

      <Section title={t('data.explore.limit')}>
        <Input
          type="number"
          min={1}
          max={50000}
          aria-label={t('data.explore.limit')}
          className="h-7 text-xs"
          value={plan.limit ?? ''}
          onChange={(event) => {
            const value = Number.parseInt(event.target.value, 10)
            onChange({ limit: Number.isNaN(value) || value < 1 ? null : Math.min(value, 50000) })
          }}
        />
      </Section>
    </div>
  )
}

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-2xs font-medium tracking-wide text-fg-muted uppercase">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

function GroupRow({
  group,
  fields,
  locale,
  onChange,
  onRemove,
}: {
  group: ExploreGroup
  fields: DatasetField[]
  locale: 'ru' | 'tg' | 'en'
  onChange: (group: ExploreGroup) => void
  onRemove: () => void
}) {
  const t = useT()
  const field = fields.find((item) => item.key === group.field)
  return (
    <div className="flex items-center gap-1">
      <Select
        value={group.field}
        onValueChange={(key) => {
          const next = fields.find((item) => item.key === key)
          onChange({ field: key, ...(next && TEMPORAL.has(next.type) ? { bucket: 'month' } : {}) })
        }}
      >
        <SelectTrigger aria-label={t('data.explore.groups')} className="h-7 min-w-0 flex-1 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {fields.map((item) => (
            <SelectItem key={item.key} value={item.key}>
              {labelOf(item, locale)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {field?.type === 'territory' ? (
        <Select
          value={group.level ?? NONE}
          onValueChange={(level) =>
            onChange({
              field: group.field,
              ...(level === NONE ? {} : { level: level as ExploreTerritoryLevel }),
            })
          }
        >
          <SelectTrigger aria-label={t('data.explore.level')} className="h-7 w-28 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('data.explore.levels.none')}</SelectItem>
            {EXPLORE_TERRITORY_LEVELS.map((level) => (
              <SelectItem key={level} value={level}>
                {t(`data.explore.levels.${level}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {field && TEMPORAL.has(field.type) ? (
        <Select
          value={group.bucket ?? NONE}
          onValueChange={(bucket) =>
            onChange({
              field: group.field,
              ...(bucket === NONE ? {} : { bucket: bucket as TimeBucket }),
            })
          }
        >
          <SelectTrigger aria-label={t('data.explore.bucket')} className="h-7 w-28 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('data.explore.buckets.none')}</SelectItem>
            {TIME_BUCKETS.map((bucket) => (
              <SelectItem key={bucket} value={bucket}>
                {t(`data.explore.buckets.${bucket}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <IconButton label={t('data.explore.remove')} size="sm" onClick={onRemove}>
        <X className="size-3.5" />
      </IconButton>
    </div>
  )
}

function MeasureRow({
  measure,
  plan,
  fields,
  numeric,
  locale,
  onChange,
  onRemove,
}: {
  measure: ExploreMeasure
  plan: ExplorePlan
  fields: readonly DatasetField[]
  numeric: DatasetField[]
  locale: 'ru' | 'tg' | 'en'
  onChange: (measure: ExploreMeasure) => void
  onRemove: () => void
}) {
  const t = useT()
  // Над какими полями считается функция: количество — над строками, различные — над любым
  const targets = measure.agg === 'count' ? [] : measure.agg === 'count_distinct' ? fields : numeric
  // Расчёт над мерой переживает смену функции и поля
  const keep = (next: ExploreMeasure): ExploreMeasure =>
    measure.calc ? { ...next, calc: measure.calc } : next
  const calcHint = !measure.calc
    ? null
    : !calcApplies(plan, measure)
      ? t('data.explore.calc.needsGroup')
      : plan.compare
        ? t('data.explore.compare.calcFromCurrent')
        : null
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <Select
          value={measure.agg}
          onValueChange={(next) => {
            const agg = next as Aggregate
            if (agg === 'count') onChange(keep({ agg }))
            else if (agg === 'expr') onChange(keep({ agg, expr: measure.expr ?? 'count()' }))
            else {
              const pool = agg === 'count_distinct' ? fields : numeric
              const field = pool.some((item) => item.key === measure.field)
                ? measure.field
                : pool[0]?.key
              onChange(keep(field ? { agg, field } : { agg: 'count' }))
            }
          }}
        >
          <SelectTrigger aria-label={t('data.explore.measures')} className="h-7 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AGGREGATES.filter(
              (agg) =>
                agg === 'count' || agg === 'count_distinct' || agg === 'expr' || numeric.length > 0,
            ).map((agg) => (
              <SelectItem key={agg} value={agg}>
                {t(`data.explore.aggregates.${agg}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {measure.agg === 'expr' ? (
          <FormulaInput
            value={measure.expr ?? ''}
            onCommit={(expr) => onChange({ ...measure, expr })}
          />
        ) : targets.length > 0 ? (
          <Select
            value={measure.field ?? targets[0]?.key}
            onValueChange={(field) => onChange(keep({ agg: measure.agg, field }))}
          >
            <SelectTrigger
              aria-label={t('data.explore.measures')}
              className="h-7 min-w-0 flex-1 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {targets.map((item) => (
                <SelectItem key={item.key} value={item.key}>
                  {labelOf(item, locale)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="min-w-0 flex-1 truncate px-1 text-xs text-fg-secondary">
            {t('data.explore.rows')}
          </span>
        )}
        <IconButton label={t('data.explore.remove')} size="sm" onClick={onRemove}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      <Select
        value={measure.calc ?? NONE}
        onValueChange={(next) => {
          const { calc: _drop, ...rest } = measure
          onChange(next === NONE ? rest : { ...rest, calc: next as ExploreCalc })
        }}
      >
        <SelectTrigger aria-label={t('data.explore.calc.label')} className="h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t('data.explore.calc.none')}</SelectItem>
          {EXPLORE_CALCS.map((calc) => (
            <SelectItem key={calc} value={calc}>
              {t(`data.explore.calc.${calc}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {calcHint ? <p className="text-2xs text-fg-muted">{calcHint}</p> : null}
    </div>
  )
}

const TEMPORAL_TYPES = new Set(['date', 'datetime'])

/**
 * Сравнение двух периодов (ADR-0217): поле даты и пресет — от последней даты в
 * данных — или свои даты; каждая мера даёт текущий период, базу, разницу и изменение.
 */
function CompareSection({
  fields,
  plan,
  onChange,
  anchor,
}: {
  fields: readonly DatasetField[]
  plan: ExplorePlan
  onChange: (patch: Partial<ExplorePlan>) => void
  anchor: string | null
}) {
  const t = useT()
  const locale = useLocale()
  const dates = fields.filter((field) => TEMPORAL_TYPES.has(field.type))
  const at = anchor ?? today()
  const compare = plan.compare ?? null
  const update = (next: ExploreCompare | null) => onChange({ compare: next })
  if (!compare) {
    return (
      <Section title={t('data.explore.compare.title')}>
        <Button
          size="sm"
          variant="secondary"
          icon={<CalendarRange className="size-3.5" />}
          disabled={dates.length === 0}
          onClick={() => {
            const field = dates[0]
            if (field) update({ field: field.key, ...comparePeriods('year', at) })
          }}
        >
          {t('data.explore.compare.add')}
        </Button>
        {dates.length === 0 ? (
          <p className="text-2xs text-fg-muted">{t('data.explore.compare.noTime')}</p>
        ) : null}
      </Section>
    )
  }
  const preset = presetOf(compare, at)
  return (
    <Section
      title={t('data.explore.compare.title')}
      action={
        <IconButton label={t('data.explore.compare.remove')} size="sm" onClick={() => update(null)}>
          <X className="size-3.5" />
        </IconButton>
      }
    >
      <Select value={compare.field} onValueChange={(field) => update({ ...compare, field })}>
        <SelectTrigger aria-label={t('data.explore.compare.field')} className="h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {dates.map((field) => (
            <SelectItem key={field.key} value={field.key}>
              {labelOf(field, locale)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={preset}
        onValueChange={(next) => {
          if (next !== 'custom') {
            update({ ...compare, ...comparePeriods(next as ComparePreset, at) })
          }
        }}
      >
        <SelectTrigger aria-label={t('data.explore.compare.preset')} className="h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {COMPARE_PRESETS.map((item) => (
            <SelectItem key={item} value={item}>
              {t(`data.explore.compare.presets.${item}`)}
            </SelectItem>
          ))}
          <SelectItem value="custom">{t('data.explore.compare.presets.custom')}</SelectItem>
        </SelectContent>
      </Select>
      <PeriodInputs
        label={t('data.explore.compare.current')}
        period={compare.current}
        onChange={(current) => update({ ...compare, current })}
      />
      <PeriodInputs
        label={t('data.explore.compare.previous')}
        period={compare.previous}
        onChange={(previous) => update({ ...compare, previous })}
      />
    </Section>
  )
}

/** Период датами «с … по …»: неверный порядок дат не принимается. */
function PeriodInputs({
  label,
  period,
  onChange,
}: {
  label: string
  period: ExplorePeriod
  onChange: (period: ExplorePeriod) => void
}) {
  const t = useT()
  const set = (patch: Partial<ExplorePeriod>) => {
    const next = { ...period, ...patch }
    if (next.from && next.to && next.from <= next.to) onChange(next)
  }
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-2xs text-fg-secondary">{label}</legend>
      <div className="flex items-center gap-1">
        <Input
          type="date"
          aria-label={`${label}: ${t('data.explore.compare.from')}`}
          className="h-7 min-w-0 flex-1 text-xs"
          value={period.from}
          onChange={(event) => set({ from: event.target.value })}
        />
        <Input
          type="date"
          aria-label={`${label}: ${t('data.explore.compare.to')}`}
          className="h-7 min-w-0 flex-1 text-xs"
          value={period.to}
          onChange={(event) => set({ to: event.target.value })}
        />
      </div>
    </fieldset>
  )
}

/**
 * Выражение вычисляемой меры над агрегатами (`sum(damage) / count()`): запрос
 * перестраивается по Enter или при уходе из поля, а не на каждый символ.
 */
function FormulaInput({ value, onCommit }: { value: string; onCommit: (expr: string) => void }) {
  const t = useT()
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = () => {
    const next = text.trim()
    if (next && next !== value) onCommit(next)
    else setText(value)
  }
  return (
    <Input
      mono
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        commit()
      }}
      aria-label={t('data.explore.formula')}
      placeholder={t('data.explore.formulaPlaceholder')}
      className="h-7 min-w-0 flex-1"
    />
  )
}

/**
 * Результат таблицей: DataGrid только для чтения. Щелчок по заголовку сортирует —
 * порядок уходит в план (`onSortChange`), сервер сортирует весь результат, а не
 * загруженную страницу; `onRowOpen` — детализация строки.
 */
export function ResultTable({
  result,
  className,
  sort = null,
  onSortChange,
  onRowOpen,
}: {
  result: QueryResult
  className?: string
  sort?: ExplorePlan['sort']
  onSortChange?: (sort: ExplorePlan['sort']) => void
  onRowOpen?: (index: number) => void
}) {
  const t = useT()
  const locale = useLocale()
  const columns = useMemo<DataGridColumn[]>(
    () =>
      result.fields.map((field) => ({
        key: field.name,
        label: field.label?.[locale] ?? field.label?.ru ?? field.name,
        type: field.type,
        ...(field.format ? { format: field.format } : {}),
      })),
    [result.fields, locale],
  )
  const rows = useMemo(
    () =>
      result.rows.map((row, index) => ({
        id: String(index),
        values: Object.fromEntries(result.fields.map((field, i) => [field.name, row[i]])),
      })),
    [result],
  )
  return (
    <DataGrid
      aria-label={t('data.explore.view.table')}
      className={cn('min-h-0 flex-1', className)}
      columns={columns}
      rowCount={rows.length}
      getRow={(index) => rows[index]}
      readOnly
      locale={locale}
      {...(onSortChange
        ? {
            sort: sort ? [{ key: sort.field, dir: sort.dir }] : [],
            onSortChange: (items: { key: string; dir: 'asc' | 'desc' }[]) => {
              const first = items[0]
              onSortChange(first ? { field: first.key, dir: first.dir } : null)
            },
          }
        : {})}
      {...(onRowOpen ? { onRowOpen: (_row: unknown, index: number) => onRowOpen(index) } : {})}
    />
  )
}
