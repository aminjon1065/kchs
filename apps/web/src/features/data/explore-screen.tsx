import { suggestChart } from '@kchs/chart-spec'
import {
  type Aggregate,
  type ChartSpec,
  type ChartType,
  type DatasetField,
  type LangText,
  type QueryResult,
  TIME_BUCKETS,
  type TimeBucket,
} from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import {
  Button,
  Callout,
  Chart,
  DataGrid,
  type DataGridColumn,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  FilterBuilder,
  IconButton,
  Input,
  ObjectIcon,
  PanelToolbar,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Spinner,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { Plus, Save, X } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { useTerritoryFilterEditor } from '~/features/gis/territory-filter.js'
import { ApiError, http } from '~/shared/api/client.js'
import {
  type ExploreGroup,
  type ExploreMeasure,
  type ExploreState,
  emptyExplore,
  exploreSpec,
  measureAlias,
} from './explore-query.js'
import { useFieldOptions } from './field-options.js'
import { filterFieldsOf, NUMERIC_TYPES } from './field-types.js'
import { datasetQuery } from './queries.js'

const AGGREGATES: Aggregate[] = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max', 'median']
const CHART_TYPES: ChartType[] = [
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
const AUTO = '__auto'
const NONE = '__none'

type View = 'table' | 'chart'

interface SavedExplore {
  explore?: ExploreState
  view?: View
  chartType?: ChartType | null
}

const labelOf = (field: DatasetField, locale: 'ru' | 'tg' | 'en') =>
  field.label[locale] ?? field.label.ru ?? field.key

/**
 * Подписи осей и легенды — в самой спецификации: сохранённый график и плитка
 * дашборда показывают «Количество», а не имя столбца `count`.
 */
function withChannelLabels(spec: ChartSpec, result: QueryResult): ChartSpec {
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

/**
 * «Исследование» (03-screens.md §7): шаги конструктора слева, результат —
 * таблица или график с умными значениями по умолчанию; «Сохранить как график».
 */
export function ExploreScreen({
  datasetId,
  tabId,
  savedState,
}: {
  datasetId: string
  tabId: string
  savedState?: SavedExplore
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const setTabState = useWorkspace((s) => s.setTabState)
  const { data: dataset, isLoading } = useQuery(datasetQuery(datasetId))

  const [state, setState] = useState<ExploreState>(
    () => savedState?.explore ?? emptyExplore(datasetId),
  )
  const [view, setView] = useState<View>(savedState?.view ?? 'chart')
  const [chartType, setChartType] = useState<ChartType | null>(savedState?.chartType ?? null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setTabState(tabId, { explore: state, view, chartType })
  }, [tabId, state, view, chartType, setTabState])

  const spec = useMemo(() => exploreSpec(state), [state])
  const specKey = useDebouncedValue(JSON.stringify(spec), 400)
  const result = useQuery({
    queryKey: ['explore', specKey],
    queryFn: () => http.post<QueryResult>('/queries/run', { spec: JSON.parse(specKey) }),
    placeholderData: keepPreviousData,
    retry: false,
  })

  const fields = dataset?.fields ?? []
  const byKey = useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields])
  const fieldOptions = useFieldOptions(fields)
  const territoryEditor = useTerritoryFilterEditor(
    fields.some((field) => field.type === 'territory'),
  )

  /** Подписи столбцов результата: поля — по схеме, меры — «функция: поле». */
  const columnLabel = useCallback(
    (name: string): string => {
      const field = byKey.get(name)
      if (field) return labelOf(field, locale)
      const measure = state.measures.find((item) => measureAlias(item) === name)
      if (!measure) return name
      const agg = t(`data.explore.aggregates.${measure.agg}`)
      const target = measure.field ? byKey.get(measure.field) : undefined
      return target ? t('data.explore.measureOf', { agg, field: labelOf(target, locale) }) : agg
    },
    [byKey, state.measures, locale, t],
  )

  // Результат с подписями мер — ими пользуются и таблица, и оси графика
  const labelled = useMemo<QueryResult | undefined>(() => {
    const data = result.data
    if (!data) return undefined
    return {
      ...data,
      fields: data.fields.map((field) => ({
        ...field,
        label: field.label ?? { ru: columnLabel(field.name) },
      })),
    }
  }, [result.data, columnLabel])

  const chartSpec = useMemo<ChartSpec | null>(() => {
    if (!labelled) return null
    return withChannelLabels(
      suggestChart(labelled, { query: JSON.parse(specKey) }, chartType ? { type: chartType } : {}),
      labelled,
    )
  }, [labelled, specKey, chartType])

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (!dataset) return <EmptyState title={t('common.states.notFound')} />

  const update = (patch: Partial<ExploreState>) => setState((current) => ({ ...current, ...patch }))
  const groupable = fields.filter((field) => !NOT_GROUPABLE.has(field.type))
  const numeric = fields.filter((field) => NUMERIC_TYPES.has(field.type))
  const filterFields = filterFieldsOf(fields, locale, fieldOptions)
  const sortable = [
    ...state.groups.map((group) => group.field),
    ...state.measures.map(measureAlias),
  ]

  let body: ReactNode
  if (result.error && !result.data) {
    body = (
      <Callout tone="danger" className="m-4" title={t('data.explore.failed')}>
        {result.error instanceof ApiError ? result.error.message : null}
      </Callout>
    )
  } else if (!labelled) {
    body = (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-fg-secondary">
        <Spinner />
        {t('data.explore.running')}
      </div>
    )
  } else if (view === 'chart' && chartSpec) {
    body = (
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <Chart spec={chartSpec} result={labelled} height={460} pending={result.isFetching} />
      </div>
    )
  } else {
    body = <ResultTable result={labelled} />
  }

  return (
    <div className="flex h-full min-h-0">
      <aside
        aria-label={t('data.explore.title')}
        className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-surface-2 p-3"
      >
        <div className="flex items-center gap-2">
          <ObjectIcon type="dataset" className="size-4 shrink-0 text-fg-muted" />
          <span className="truncate text-sm font-semibold text-fg">{dataset.name}</span>
        </div>

        <Section title={t('data.explore.filters')}>
          <FilterBuilder
            fields={filterFields}
            value={state.filter}
            onChange={(filter) => update({ filter })}
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
                  (field) => !state.groups.some((group) => group.field === field.key),
                )
                if (next) {
                  update({
                    groups: [
                      ...state.groups,
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
          {state.groups.map((group, index) => (
            <GroupRow
              key={`${group.field}-${index}`}
              group={group}
              fields={groupable}
              locale={locale}
              onChange={(next) =>
                update({ groups: state.groups.map((item, i) => (i === index ? next : item)) })
              }
              onRemove={() => update({ groups: state.groups.filter((_, i) => i !== index) })}
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
                update({
                  measures: [
                    ...state.measures,
                    numeric[0] ? { agg: 'sum', field: numeric[0].key } : { agg: 'count' },
                  ],
                })
              }
            >
              <Plus className="size-3.5" />
            </IconButton>
          }
        >
          {state.measures.map((measure, index) => (
            <MeasureRow
              key={`${measureAlias(measure)}-${index}`}
              measure={measure}
              fields={fields}
              numeric={numeric}
              locale={locale}
              onChange={(next) =>
                update({ measures: state.measures.map((item, i) => (i === index ? next : item)) })
              }
              onRemove={() => update({ measures: state.measures.filter((_, i) => i !== index) })}
            />
          ))}
        </Section>

        <Section title={t('data.explore.sort')}>
          <div className="flex flex-col gap-2">
            <Select
              value={
                state.sort?.field && sortable.includes(state.sort.field) ? state.sort.field : NONE
              }
              onValueChange={(field) =>
                update({ sort: field === NONE ? null : { field, dir: state.sort?.dir ?? 'desc' } })
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
            {state.sort ? (
              <SegmentedControl
                size="sm"
                aria-label={t('data.explore.sort')}
                value={state.sort.dir}
                onValueChange={(dir) =>
                  state.sort && update({ sort: { field: state.sort.field, dir } })
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
            value={state.limit ?? ''}
            onChange={(event) => {
              const value = Number.parseInt(event.target.value, 10)
              update({ limit: Number.isNaN(value) || value < 1 ? null : Math.min(value, 50000) })
            }}
          />
        </Section>
      </aside>

      <section aria-label={t('data.explore.title')} className="flex min-w-0 flex-1 flex-col">
        <PanelToolbar
          left={
            <>
              <SegmentedControl
                size="sm"
                aria-label={t('data.explore.title')}
                value={view}
                onValueChange={setView}
                options={[
                  { value: 'chart', label: t('data.explore.view.chart') },
                  { value: 'table', label: t('data.explore.view.table') },
                ]}
              />
              {view === 'chart' ? (
                <Select
                  value={chartType ?? AUTO}
                  onValueChange={(next) => setChartType(next === AUTO ? null : (next as ChartType))}
                >
                  <SelectTrigger
                    aria-label={t('data.explore.chartType')}
                    className="h-7 w-40 text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO}>{t('data.explore.auto')}</SelectItem>
                    {CHART_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {t(`data.chartTypes.${type}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </>
          }
          right={
            <Button
              variant="primary"
              size="sm"
              icon={<Save className="size-3.5" />}
              disabled={!chartSpec}
              onClick={() => setSaving(true)}
            >
              {t('data.explore.save')}
            </Button>
          }
        />
        {result.data?.truncated ? (
          <Callout tone="warning" className="mx-4 mt-3">
            {t('data.explore.truncated', { count: result.data.rows.length })}
          </Callout>
        ) : null}
        {body}
        {result.data ? (
          <div className="flex h-7 shrink-0 items-center gap-2 border-t border-line bg-surface-2 px-3 text-2xs text-fg-muted tabular">
            {t('data.explore.summary', {
              count: result.data.rows.length,
              ms: formatNumber(Math.round(result.data.durationMs), {}, { locale }),
            })}
            {result.data.cached ? ` · ${t('data.explore.cached')}` : ''}
            {result.isFetching ? <Spinner className="size-3" /> : null}
          </div>
        ) : null}
      </section>

      {saving && chartSpec ? (
        <SaveChartDialog
          spaceId={dataset.spaceId}
          defaultName={`${dataset.name} — ${columnLabel(measureAlias(state.measures[0] ?? { agg: 'count' }))}`}
          spec={{ ...chartSpec, type: view === 'table' ? 'table' : chartSpec.type }}
          onClose={() => setSaving(false)}
        />
      ) : null}
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
  fields: DatasetField[]
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
            (agg) => agg === 'count' || agg === 'count_distinct' || numeric.length > 0,
          ).map((agg) => (
            <SelectItem key={agg} value={agg}>
              {t(`data.explore.aggregates.${agg}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {targets.length > 0 ? (
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

/** Результат таблицей: DataGrid только для чтения. */
function ResultTable({ result }: { result: QueryResult }) {
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
      className="min-h-0 flex-1"
      columns={columns}
      rowCount={rows.length}
      getRow={(index) => rows[index]}
      readOnly
      locale={locale}
    />
  )
}

function SaveChartDialog({
  spaceId,
  defaultName,
  spec,
  onClose,
}: {
  spaceId: string
  defaultName: string
  spec: ChartSpec
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const openTab = useWorkspace((s) => s.openTab)
  const [name, setName] = useState(defaultName)
  const [failure, setFailure] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: () => http.post<{ id: string }>('/charts', { name: name.trim(), spaceId, spec }),
    onSuccess: ({ id }) => {
      toast.show({ title: t('data.explore.saved'), tone: 'success' })
      onClose()
      openTab({
        kind: 'object',
        objectId: id,
        objectType: 'chart',
        title: name.trim(),
        mode: 'permanent',
      })
    },
    onError: (error) => setFailure(error instanceof ApiError ? error.message : t('errors.unknown')),
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('data.explore.saveTitle')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!name.trim()}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {t('data.explore.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field label={t('data.explore.name')}>
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label={t('data.explore.name')}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
