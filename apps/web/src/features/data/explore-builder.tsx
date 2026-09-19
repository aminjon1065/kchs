import {
  type Aggregate,
  type ChartSpec,
  type ChartType,
  type DatasetField,
  type ExploreGroup,
  type ExploreMeasure,
  type ExplorePlan,
  groupAlias,
  type LangText,
  measureAlias,
  type QueryResult,
  TIME_BUCKETS,
  type TimeBucket,
} from '@kchs/contracts'
import {
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
import { Plus, X } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { optionLabels, useLabelledResult } from '~/features/gis/result-labels.js'
import { useTerritoryFilterEditor } from '~/features/gis/territory-filter.js'
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
export const CHART_TYPES: ChartType[] = [
  'bar',
  'line',
  'area',
  'pie',
  'donut',
  'table',
  'number',
  'scatter',
  'heatmap',
  'treemap',
  'funnel',
]
/** Поля, которые не годятся в разрез. */
const NOT_GROUPABLE = new Set<string>(['geometry', 'json', 'long_text', 'multi_select'])
const TEMPORAL = new Set<string>(['date', 'datetime'])
const NONE = '__none'

export const labelOf = (field: DatasetField, locale: 'ru' | 'tg' | 'en') =>
  field.label[locale] ?? field.label.ru ?? field.key

/**
 * Подписи осей и легенды — в самой спецификации: сохранённый график и плитка
 * дашборда показывают «Количество», а не имя столбца `count`.
 */
export function withChannelLabels(spec: ChartSpec, result: QueryResult): ChartSpec {
  const labels = new Map(result.fields.map((field) => [field.name, field.label]))
  const label = <T extends { field: string; label?: LangText }>(channel: T): T => {
    const text = labels.get(channel.field)
    return text && !channel.label ? { ...channel, label: text } : channel
  }
  const encoding = spec.encoding
  return {
    ...spec,
    encoding: {
      ...encoding,
      ...(encoding.x ? { x: label(encoding.x) } : {}),
      y: encoding.y.map(label),
      ...(encoding.color && 'field' in encoding.color ? { color: label(encoding.color) } : {}),
      ...(encoding.size ? { size: label(encoding.size) } : {}),
    },
  }
}

/** Изменение плана: сортировка по столбцу, которого в сводке больше нет, снимается. */
export function updatePlan<T extends ExplorePlan>(current: T, patch: Partial<ExplorePlan>): T {
  const next = { ...current, ...patch }
  if (next.sort && (next.groups.length > 0 || next.measures.length > 0)) {
    const columns = [...next.groups.map(groupAlias), ...next.measures.map(measureAlias)]
    if (!columns.includes(next.sort.field)) next.sort = null
  }
  return next
}

/**
 * Подписи результата: поля — по схеме, меры — «функция: поле», значения
 * территорий и справочников — подписями (ADR-0057).
 */
export function useExploreLabels(
  fields: readonly DatasetField[],
  plan: ExplorePlan,
  result: QueryResult | undefined,
): { columnLabel: (name: string) => string; labelled: QueryResult | undefined } {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const byKey = useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields])
  const fieldOptions = useFieldOptions(fields)

  const columnLabel = useCallback(
    (name: string): string => {
      const field = byKey.get(name)
      if (field) return labelOf(field, locale)
      const group = plan.groups.find((item) => item.bucket && groupAlias(item) === name)
      const grouped = group ? byKey.get(group.field) : undefined
      if (group?.bucket && grouped) {
        return `${labelOf(grouped, locale)} · ${t(`data.explore.buckets.${group.bucket}`)}`
      }
      const measure = plan.measures.find((item) => measureAlias(item) === name)
      if (!measure) return name
      if (measure.agg === 'expr') return measure.name || measure.expr || name
      const agg = t(`data.explore.aggregates.${measure.agg}`)
      const target = measure.field ? byKey.get(measure.field) : undefined
      return target ? t('data.explore.measureOf', { agg, field: labelOf(target, locale) }) : agg
    },
    [byKey, plan.groups, plan.measures, locale, t],
  )

  const valueLabels = useMemo(
    () =>
      new Map(
        [...fieldOptions].map(([key, options]) => [key, optionLabels(options, locale)] as const),
      ),
    [fieldOptions, locale],
  )
  const relabelled = useLabelledResult(result, valueLabels)

  // Результат с подписями мер — ими пользуются и таблица, и оси графика
  const labelled = useMemo<QueryResult | undefined>(() => {
    if (!relabelled) return undefined
    return {
      ...relabelled,
      fields: relabelled.fields.map((field) => ({
        ...field,
        label: field.label ?? { ru: columnLabel(field.name) },
      })),
    }
  }, [relabelled, columnLabel])

  return { columnLabel, labelled }
}

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
}: {
  fields: readonly DatasetField[]
  plan: ExplorePlan
  onChange: (patch: Partial<ExplorePlan>) => void
  columnLabel: (name: string) => string
  compact?: boolean
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const fieldOptions = useFieldOptions(fields)
  const territoryEditor = useTerritoryFilterEditor(
    fields.some((field) => field.type === 'territory'),
  )
  const groupable = fields.filter((field) => !NOT_GROUPABLE.has(field.type))
  const numeric = fields.filter((field) => NUMERIC_TYPES.has(field.type))
  const filterFields = filterFieldsOf(fields, locale, fieldOptions)
  const sortable = [...plan.groups.map(groupAlias), ...plan.measures.map(measureAlias)]

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
  fields,
  numeric,
  locale,
  onChange,
  onRemove,
}: {
  measure: ExploreMeasure
  fields: readonly DatasetField[]
  numeric: DatasetField[]
  locale: 'ru' | 'tg' | 'en'
  onChange: (measure: ExploreMeasure) => void
  onRemove: () => void
}) {
  const t = useT()
  // Над какими полями считается функция: количество — над строками, различные — над любым
  const targets = measure.agg === 'count' ? [] : measure.agg === 'count_distinct' ? fields : numeric
  return (
    <div className="flex items-center gap-1">
      <Select
        value={measure.agg}
        onValueChange={(next) => {
          const agg = next as Aggregate
          if (agg === 'count') onChange({ agg })
          else if (agg === 'expr') onChange({ agg, expr: measure.expr ?? 'count()' })
          else {
            const pool = agg === 'count_distinct' ? fields : numeric
            const field = pool.some((item) => item.key === measure.field)
              ? measure.field
              : pool[0]?.key
            onChange(field ? { agg, field } : { agg: 'count' })
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
          onValueChange={(field) => onChange({ agg: measure.agg, field })}
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

/** Результат таблицей: DataGrid только для чтения. */
export function ResultTable({ result, className }: { result: QueryResult; className?: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
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
    />
  )
}
