import type { ChartPick } from '@kchs/chart-spec'
import {
  type ChoroplethLevel,
  type DatasetField,
  type ExploreCompare,
  type ExplorePlan,
  type ExploreTerritoryLevel,
  explorePlanSpec,
  type FilterNode,
  type QueryResult,
} from '@kchs/contracts'
import { formatDate, formatValue } from '@kchs/fields'
import {
  Button,
  Callout,
  IconButton,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { ChevronsDown, Rows3, X } from 'lucide-react'
import { Suspense, useState } from 'react'
import { LazyChoroplethPreview, LazyPointsPreview } from '~/features/gis/index.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { labelOf, ResultTable, useExploreLabels } from './explore-builder.js'
import { fieldKind } from './explore-insights.js'
import { exploreFailure, exploreRunQuery } from './explore-queries.js'

/**
 * Результат «Исследования» для аналитика (ADR-0217): итоги таблицы, детализация
 * выбранного элемента, сырые строки за ним, карта, понятные пустые состояния и ошибки.
 */

/** Строка результата под элементом графика: условия выбора — по подписям. */
export function pickedRow(labelled: QueryResult, pick: ChartPick): number | null {
  const conditions = pick.filters.filter((item) => item.op === 'eq' || item.op === 'in')
  if (conditions.length === 0) return null
  const index = labelled.rows.findIndex((row) =>
    conditions.every((condition) => {
      const column = labelled.fields.findIndex((field) => field.name === condition.field)
      if (column < 0) return false
      const value = row[column]
      return condition.op === 'in' && Array.isArray(condition.value)
        ? condition.value.includes(value)
        : value === condition.value
    }),
  )
  return index >= 0 ? index : null
}

/**
 * Итоги таблицы — отдельным запросом того же плана без разрезов: точны для любой
 * меры (среднего, медианы, различных), а не сумма видимых строк.
 */
export function ResultTotals({
  datasetId,
  plan,
  columnLabel,
}: {
  datasetId: string
  plan: ExplorePlan
  columnLabel: (name: string) => string
}) {
  const t = useT()
  const locale = useLocale()
  const totalsPlan: ExplorePlan = {
    ...plan,
    groups: [],
    sort: null,
    limit: null,
    measures: plan.measures.map(({ calc: _calc, ...measure }) => measure),
  }
  const { data } = useQuery(
    exploreRunQuery('totals', explorePlanSpec(datasetId, totalsPlan), plan.groups.length > 0),
  )
  const row = data?.rows[0]
  if (!data || !row) return null
  return (
    <section
      aria-label={t('data.explore.totals')}
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-surface-2 px-3 py-1.5 text-xs"
    >
      <span className="font-semibold text-fg">{t('data.explore.totals')}</span>
      {data.fields.map((field, index) => (
        <span key={field.name} className="text-fg-secondary">
          {columnLabel(field.name)}:{' '}
          <span className="tabular font-medium text-fg">
            {formatValue(
              row[index],
              { type: field.type, ...(field.format ? { format: field.format } : {}) },
              { locale },
            ) || '—'}
          </span>
        </span>
      ))}
    </section>
  )
}

/** Подпись периодов сравнения над результатом. */
export function CompareCaption({ compare }: { compare: ExploreCompare }) {
  const t = useT()
  const locale = useLocale()
  const period = (from: string, to: string) =>
    `${formatDate(from, { locale })} — ${formatDate(to, { locale })}`
  return (
    <p className="shrink-0 px-4 pt-3 text-xs text-fg-secondary">
      {t('data.explore.compare.caption', {
        current: period(compare.current.from, compare.current.to),
        previous: period(compare.previous.from, compare.previous.to),
      })}
    </p>
  )
}

/**
 * Выбранный элемент: оставить только его, разбить по другому полю, показать строки;
 * у территории уровнем справочника — спуститься на уровень ниже (ADR-0217, «Дополнено»).
 */
export function DrillBar({
  value,
  fields,
  exclude,
  deeper = null,
  onOnly,
  onSplit,
  onDeeper,
  onRows,
  onClose,
}: {
  value: string
  fields: readonly DatasetField[]
  exclude: readonly string[]
  /** Следующий уровень территории разреза; null — спускаться некуда. */
  deeper?: ExploreTerritoryLevel | null
  onOnly: () => void
  onSplit: (field: string) => void
  onDeeper?: () => void
  onRows: () => void
  onClose: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const choices = fields.filter(
    (field) =>
      !exclude.includes(field.key) &&
      ['category', 'territory', 'time'].includes(fieldKind(field)) &&
      field.semantic !== 'identifier',
  )
  return (
    <section
      aria-label={t('data.explore.drill.title', { value })}
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-accent-subtle px-3 py-2 text-xs"
    >
      <span className="min-w-0 truncate font-medium text-fg">
        {t('data.explore.drill.title', { value })}
      </span>
      <Button size="sm" variant="secondary" onClick={onOnly}>
        {t('data.explore.drill.only')}
      </Button>
      {deeper && onDeeper ? (
        <Button
          size="sm"
          variant="secondary"
          icon={<ChevronsDown className="size-3.5" />}
          onClick={onDeeper}
        >
          {t('data.explore.drill.deeper', {
            level: t(`data.explore.mapView.levels.${deeper}`),
          })}
        </Button>
      ) : null}
      {choices.length > 0 ? (
        <Select value="" onValueChange={onSplit}>
          <SelectTrigger aria-label={t('data.explore.drill.splitBy')} className="h-7 w-48 text-xs">
            <SelectValue placeholder={t('data.explore.drill.splitBy')} />
          </SelectTrigger>
          <SelectContent>
            {choices.map((field) => (
              <SelectItem key={field.key} value={field.key}>
                {labelOf(field, locale)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <Button size="sm" variant="secondary" icon={<Rows3 className="size-3.5" />} onClick={onRows}>
        {t('data.explore.drill.rows')}
      </Button>
      <IconButton label={t('data.explore.drill.close')} size="sm" onClick={onClose}>
        <X className="size-3.5" />
      </IconButton>
    </section>
  )
}

const ROWS_LIMIT = 200

/** Сырые строки за выбранным элементом — первые 200, с переходом в датасет. */
export function RowsPanel({
  datasetId,
  datasetName,
  fields,
  filter,
  title,
  onClose,
}: {
  datasetId: string
  datasetName: string
  fields: readonly DatasetField[]
  filter: FilterNode
  title: string
  onClose: () => void
}) {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const plan: ExplorePlan = { filter, groups: [], measures: [], sort: null, limit: ROWS_LIMIT }
  const { data, error } = useQuery(exploreRunQuery('rows', explorePlanSpec(datasetId, plan)))
  const { labelled } = useExploreLabels(fields, plan, data)
  return (
    <section
      aria-label={t('data.explore.drill.rowsTitle', { value: title })}
      className="flex h-72 shrink-0 flex-col border-t border-line"
    >
      <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-1.5 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium text-fg">
          {t('data.explore.drill.rowsTitle', { value: title })}
        </span>
        {data ? (
          <span className="text-fg-muted">
            {t('data.explore.drill.rowsShown', { count: data.rows.length })}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            openTab({
              kind: 'object',
              objectId: datasetId,
              objectType: 'dataset',
              title: datasetName,
            })
          }
        >
          {t('data.explore.drill.openDataset')}
        </Button>
        <IconButton label={t('common.actions.close')} size="sm" onClick={onClose}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      {error ? (
        <ResultError error={error} />
      ) : labelled ? (
        <ResultTable result={labelled} />
      ) : (
        <Skeleton className="m-3 h-40" />
      )}
    </section>
  )
}

const LEVELS: ChoroplethLevel[] = ['region', 'district', 'jamoat']

type MapMode = 'territories' | 'points'

/**
 * Карта: хороплет по территориям — по полю-территории разреза или геометрии
 * датасета; значение — первая мера (количество, сумма или среднее). У датасета с
 * полем-точкой — ещё и сами точки с кластерами (ADR-0217, «Дополнено»).
 */
export function MapView({
  datasetId,
  fields,
  plan,
}: {
  datasetId: string
  fields: readonly DatasetField[]
  plan: ExplorePlan
}) {
  const t = useT()
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const territory = plan.groups.find(
    (group) => !group.bucket && byKey.get(group.field)?.type === 'territory',
  )
  const [level, setLevel] = useState<ChoroplethLevel>(territory?.level ?? 'district')
  const geometry = fields.find((field) => field.type === 'geometry')
  const point = fields.find((field) => field.type === 'geometry' && field.geometryType === 'point')
  const field = territory?.field ?? geometry?.key
  const [mode, setMode] = useState<MapMode>(territory || !point ? 'territories' : 'points')
  if (!field) {
    return (
      <Callout tone="info" className="m-4">
        {t('data.explore.mapView.unavailable')}
      </Callout>
    )
  }
  const first = plan.measures[0]
  const measure =
    first && (first.agg === 'sum' || first.agg === 'avg') && first.field
      ? { agg: first.agg, field: first.field }
      : { agg: 'count' as const, field: null }
  const points = mode === 'points' && point ? point : null
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-3">
        {point ? (
          <SegmentedControl
            size="sm"
            aria-label={t('data.explore.mapView.mode')}
            value={mode}
            onValueChange={setMode}
            options={(['territories', 'points'] as const).map((value) => ({
              value,
              label: t(`data.explore.mapView.modes.${value}`),
            }))}
          />
        ) : null}
        {points ? null : (
          <>
            <SegmentedControl
              size="sm"
              aria-label={t('data.explore.mapView.level')}
              value={level}
              onValueChange={setLevel}
              options={LEVELS.map((value) => ({
                value,
                label: t(`data.explore.mapView.levels.${value}`),
              }))}
            />
            <span className="text-xs text-fg-muted">{t('data.explore.mapView.measure')}</span>
          </>
        )}
      </div>
      <Suspense fallback={<Skeleton className="h-72 w-full" />}>
        {points ? (
          <LazyPointsPreview datasetId={datasetId} field={points.key} filter={plan.filter} />
        ) : (
          <LazyChoroplethPreview
            params={{
              datasetId,
              join: territory ? 'territory' : 'geometry',
              field,
              level,
              filter: plan.filter,
              measure,
            }}
          />
        )}
      </Suspense>
    </div>
  )
}

/**
 * Пустой результат объясняется: фильтр или периоды сравнения отсекли все строки —
 * с кнопкой, которая их убирает; иначе — в датасете нет строк.
 */
export function EmptyResult({
  plan,
  range,
  onRemoveFilter,
  onRemoveCompare,
}: {
  plan: ExplorePlan
  range: { min: string | null; max: string | null }
  onRemoveFilter: () => void
  onRemoveCompare: () => void
}) {
  const t = useT()
  const locale = useLocale()
  if (plan.filter) {
    return (
      <Callout tone="info" className="m-4" title={t('data.explore.empty.filtered')}>
        <p>{t('data.explore.empty.filteredHint')}</p>
        <Button size="sm" variant="secondary" className="mt-2" onClick={onRemoveFilter}>
          {t('data.explore.empty.removeFilter')}
        </Button>
      </Callout>
    )
  }
  if (plan.compare) {
    return (
      <Callout tone="info" className="m-4" title={t('data.explore.empty.period')}>
        {range.min && range.max ? (
          <p>
            {t('data.explore.empty.periodHint', {
              min: formatDate(range.min, { locale }),
              max: formatDate(range.max, { locale }),
            })}
          </p>
        ) : null}
        <Button size="sm" variant="secondary" className="mt-2" onClick={onRemoveCompare}>
          {t('data.explore.compare.remove')}
        </Button>
      </Callout>
    )
  }
  return (
    <Callout tone="info" className="m-4">
      {t('data.explore.empty.noRows')}
    </Callout>
  )
}

/** Ошибка запроса человеческим текстом и что сделать. */
export function ResultError({ error, onReset }: { error: unknown; onReset?: () => void }) {
  const t = useT()
  const failure = exploreFailure(error)
  const [title, hint] =
    failure.kind === 'timeout'
      ? [t('data.explore.errors.timeout'), t('data.explore.errors.timeoutHint')]
      : failure.kind === 'forbidden'
        ? [t('data.explore.errors.forbidden'), t('data.explore.errors.forbiddenHint')]
        : failure.kind === 'invalid'
          ? [t('data.explore.errors.invalid'), failure.message]
          : [t('data.explore.failed'), failure.message ?? t('errors.unknown')]
  return (
    <Callout tone="danger" className="m-4" title={title}>
      <p>{hint}</p>
      {onReset ? (
        <Button size="sm" variant="secondary" className="mt-2" onClick={onReset}>
          {t('data.explore.errors.reset')}
        </Button>
      ) : null}
    </Callout>
  )
}
