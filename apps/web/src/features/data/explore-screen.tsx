import { suggestChart } from '@kchs/chart-spec'
import {
  type AskDataResult,
  type ChartSpec,
  type ChartType,
  type FilterNode,
  groupAlias,
  measureAlias,
} from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import {
  Button,
  Callout,
  Chart,
  type ChartHandle,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LayoutGrid, Save } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { AskBox } from './ask-box.js'
import {
  CHART_TYPES,
  ExplorePlanEditor,
  ResultTable,
  updatePlan,
  useExploreLabels,
  withChannelLabels,
} from './explore-builder.js'
import {
  andFilter,
  type ExploreQuestion,
  groupValueFilter,
  nextLevel,
  smartPlan,
  timeFieldOf,
} from './explore-insights.js'
import { ExploreOverview, useDataRange } from './explore-overview.js'
import { exploreApi, exploreFailure, exploreRunQuery } from './explore-queries.js'
import { type ExploreState, emptyExplore, exploreSpec } from './explore-query.js'
import {
  CompareCaption,
  DrillBar,
  EmptyResult,
  MapView,
  pickedRow,
  ResultError,
  ResultTotals,
  RowsPanel,
} from './explore-result.js'
import { ExploreSaveMenu } from './explore-save.js'
import { datasetQuery } from './queries.js'
import { chartHasImage, ResultExportMenu } from './result-export.js'

const AUTO = '__auto'

type View = 'table' | 'chart' | 'map'
/** Обзор датасета — первый вид; результат — после вопроса или правки плана (ADR-0217). */
type Mode = 'overview' | 'result'

interface SavedExplore {
  explore?: ExploreState
  view?: View
  chartType?: ChartType | null
  mode?: Mode
}

/**
 * «Исследование» (03-screens.md §7, ADR-0217): шаги конструктора слева; справа —
 * обзор датасета с готовыми вопросами, а после вопроса или правки плана —
 * результат графиком, таблицей с итогами или картой, с детализацией элемента.
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
  const locale = useLocale()
  const client = useQueryClient()
  const setTabState = useWorkspace((s) => s.setTabState)
  // Без датасета (адрес `/explore` без него) запросы не уходят — экран просит выбрать датасет
  const hasDataset = datasetId !== ''
  const { data: dataset, isLoading } = useQuery({ ...datasetQuery(datasetId), enabled: hasDataset })
  const range = useDataRange(dataset)
  const anchor = range.max?.slice(0, 10) ?? null

  const [state, setState] = useState<ExploreState>(
    () => savedState?.explore ?? emptyExplore(datasetId),
  )
  const [view, setView] = useState<View>(savedState?.view ?? 'chart')
  const [chartType, setChartType] = useState<ChartType | null>(savedState?.chartType ?? null)
  const [mode, setMode] = useState<Mode>(
    savedState?.mode ?? (savedState?.explore ? 'result' : 'overview'),
  )
  /** Выбранная строка результата (детализация) и строки за ней. */
  const [drill, setDrill] = useState<number | null>(null)
  const [rows, setRows] = useState<{ filter: FilterNode; title: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const chartRef = useRef<ChartHandle | null>(null)

  useEffect(() => {
    setTabState(tabId, { explore: state, view, chartType, mode })
  }, [tabId, state, view, chartType, mode, setTabState])

  const spec = useMemo(() => exploreSpec(state), [state])
  const specKey = useDebouncedValue(JSON.stringify(spec), 400)
  // Отложенная спецификация — та же `spec`: её JSON служит ключом запроса
  const settled = useMemo((): typeof spec => JSON.parse(specKey), [specKey])
  const result = useQuery(exploreRunQuery('run', settled, hasDataset))

  const fields = dataset?.fields ?? []
  const { columnLabel, labelled } = useExploreLabels(fields, state, result.data)

  const chartSpec = useMemo<ChartSpec | null>(() => {
    if (!labelled || labelled.rows.length === 0) return null
    return withChannelLabels(
      suggestChart(labelled, { query: settled }, chartType ? { type: chartType } : {}),
      labelled,
    )
  }, [labelled, settled, chartType])

  if (!hasDataset) {
    return (
      <EmptyState
        title={t('data.explore.noDataset')}
        description={t('data.explore.noDatasetHint')}
      />
    )
  }
  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (!dataset) return <EmptyState title={t('common.states.notFound')} />

  const byKey = new Map(fields.map((field) => [field.key, field]))
  const reset = () => {
    setDrill(null)
    setRows(null)
  }
  /** Правка плана в конструкторе — показать результат. */
  const update = (patch: Parameters<typeof updatePlan>[1]) => {
    setState((current) => updatePlan(current, patch))
    setMode('result')
    reset()
  }
  const apply = (question: Pick<ExploreQuestion, 'plan' | 'view' | 'chartType'>) => {
    setState({ datasetId, ...question.plan })
    setView(question.view)
    setChartType(question.chartType)
    setMode('result')
    reset()
  }

  /**
   * Ответ «Спросить данные»: план — в конструктор (его видно и можно править),
   * результат сервера — в кэш под тем же запросом, чтобы не выполнять его снова.
   */
  const applyAnswer = (answer: AskDataResult) => {
    const next: ExploreState = { datasetId, ...answer.plan }
    client.setQueryData(exploreRunQuery('run', exploreSpec(next)).queryKey, answer.result)
    apply({
      plan: answer.plan,
      view: answer.chart === 'table' ? 'table' : 'chart',
      chartType: answer.chart === 'table' ? null : answer.chart,
    })
  }

  // Детализация: значения разрезов выбранной строки — из сырого результата, не из подписей
  const raw = result.data
  const drillFilter = (index: number): FilterNode | null => {
    const row = raw?.rows[index]
    if (!raw || !row || state.groups.length === 0) return null
    const conditions = state.groups.map((group) => {
      const column = raw.fields.findIndex((field) => field.name === groupAlias(group))
      return groupValueFilter(group, byKey.get(group.field), column >= 0 ? row[column] : null)
    })
    return conditions.length === 1 ? (conditions[0] as FilterNode) : { and: conditions }
  }
  const drillLabel = (index: number): string => {
    const row = labelled?.rows[index]
    if (!labelled || !row) return ''
    return state.groups
      .map((group) => {
        const column = labelled.fields.findIndex((field) => field.name === groupAlias(group))
        const value = column >= 0 ? row[column] : null
        return value === null || value === undefined || value === ''
          ? t('data.explore.drill.empty')
          : String(value)
      })
      .join(' · ')
  }
  const select = (index: number | null) => {
    setDrill(index !== null && state.groups.length > 0 ? index : null)
    setRows(null)
  }

  const rowsCount = labelled?.rows.length ?? 0
  let body: ReactNode
  if (mode === 'overview') {
    body = (
      <ExploreOverview
        dataset={dataset}
        range={range}
        onPick={apply}
        onOwn={() => apply({ plan: smartPlan(dataset), view: 'chart', chartType: null })}
      />
    )
  } else if (result.error && !result.data) {
    body = (
      <ResultError
        error={result.error}
        onReset={() => apply({ plan: smartPlan(dataset), view: 'chart', chartType: null })}
      />
    )
  } else if (!labelled) {
    body = (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-fg-secondary">
        <Spinner />
        {t('data.explore.running')}
      </div>
    )
  } else if (rowsCount === 0) {
    body = (
      <EmptyResult
        plan={state}
        range={range}
        onRemoveFilter={() => update({ filter: null })}
        onRemoveCompare={() => update({ compare: null })}
      />
    )
  } else if (view === 'map') {
    body = <MapView datasetId={datasetId} fields={fields} plan={state} />
  } else if (view === 'chart' && chartSpec) {
    body = (
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <Chart
          spec={chartSpec}
          result={labelled}
          height={460}
          pending={result.isFetching}
          handleRef={chartRef}
          onElementClick={(pick) => select(pickedRow(labelled, pick))}
        />
      </div>
    )
  } else {
    body = (
      <>
        <ResultTable
          result={labelled}
          sort={state.sort}
          onSortChange={(sort) => update({ sort })}
          onRowOpen={(index) => select(index)}
        />
        <ResultTotals datasetId={datasetId} plan={state} columnLabel={columnLabel} />
      </>
    )
  }

  const views: Array<{ value: View; label: string }> = [
    { value: 'chart', label: t('data.explore.view.chart') },
    { value: 'table', label: t('data.explore.view.table') },
    { value: 'map', label: t('data.explore.view.map') },
  ]
  const drillValue = drill !== null ? drillLabel(drill) : ''
  const drillWhere = drill !== null ? drillFilter(drill) : null
  // Территория уровнем справочника: выбранная единица раскрывается уровнем ниже
  const deepIndex = state.groups.findIndex((group) => nextLevel(group) !== null)
  const deepGroup = state.groups[deepIndex]
  const deeper = deepGroup ? nextLevel(deepGroup) : null

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

        <ExplorePlanEditor
          fields={fields}
          plan={state}
          onChange={update}
          columnLabel={columnLabel}
          anchor={anchor}
        />
      </aside>

      <section aria-label={t('data.explore.title')} className="flex min-w-0 flex-1 flex-col">
        <PanelToolbar
          left={
            <>
              <Button
                size="sm"
                variant={mode === 'overview' ? 'secondary' : 'ghost'}
                icon={<LayoutGrid className="size-3.5" />}
                aria-pressed={mode === 'overview'}
                onClick={() => setMode(mode === 'overview' ? 'result' : 'overview')}
              >
                {t('data.explore.overview')}
              </Button>
              {mode === 'result' ? (
                <SegmentedControl
                  size="sm"
                  aria-label={t('data.explore.title')}
                  value={view}
                  onValueChange={setView}
                  options={views}
                />
              ) : null}
              {mode === 'result' && view === 'chart' ? (
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
            <>
              <ResultExportMenu
                data={
                  result.data
                    ? {
                        path: '/queries/export',
                        body: {
                          spec: settled,
                          name: dataset.name,
                          labels: Object.fromEntries(
                            result.data.fields.map((field) => [
                              field.name,
                              columnLabel(field.name),
                            ]),
                          ),
                        },
                      }
                    : null
                }
                chart={
                  mode === 'result' &&
                  view === 'chart' &&
                  chartSpec &&
                  chartHasImage(chartSpec.type)
                    ? chartRef
                    : null
                }
                name={dataset.name}
              />
              <Button
                variant="primary"
                size="sm"
                icon={<Save className="size-3.5" />}
                disabled={!chartSpec || view === 'map'}
                onClick={() => setSaving(true)}
              >
                {t('data.explore.save')}
              </Button>
              <ExploreSaveMenu
                datasetId={datasetId}
                spaceId={dataset.spaceId}
                name={dataset.name}
                plan={{
                  filter: state.filter,
                  groups: state.groups,
                  measures: state.measures,
                  sort: state.sort,
                  limit: state.limit,
                  ...(state.compare ? { compare: state.compare } : {}),
                }}
                view={view}
                chartType={chartType}
                chartSpec={view === 'map' ? null : chartSpec}
                spec={settled}
                columnLabel={columnLabel}
                timeField={timeFieldOf(dataset)?.key ?? null}
              />
            </>
          }
        />
        <AskBox datasetId={datasetId} onAnswer={applyAnswer} />
        {mode === 'result' && state.compare && state.groups.length + state.measures.length > 0 ? (
          <CompareCaption compare={state.compare} />
        ) : null}
        {mode === 'result' && result.data?.truncated ? (
          <Callout tone="warning" className="mx-4 mt-3">
            {t('data.explore.truncated', { count: result.data.rows.length })}
          </Callout>
        ) : null}
        {mode === 'result' && drill !== null && drillWhere ? (
          <DrillBar
            value={drillValue}
            fields={fields}
            exclude={state.groups.map((group) => group.field)}
            deeper={deeper}
            onOnly={() => update({ filter: andFilter(state.filter, drillWhere) })}
            onDeeper={() =>
              update({
                filter: andFilter(state.filter, drillWhere),
                groups: state.groups.map((group, index) =>
                  index === deepIndex && deeper ? { ...group, level: deeper } : group,
                ),
              })
            }
            onSplit={(key) => {
              const field = byKey.get(key)
              const temporal = field?.type === 'date' || field?.type === 'datetime'
              update({
                filter: andFilter(state.filter, drillWhere),
                groups: [{ field: key, ...(temporal ? { bucket: 'month' as const } : {}) }],
              })
            }}
            onRows={() =>
              setRows({ filter: andFilter(state.filter, drillWhere), title: drillValue })
            }
            onClose={() => select(null)}
          />
        ) : null}
        {body}
        {mode === 'result' && rows ? (
          <RowsPanel
            datasetId={datasetId}
            datasetName={dataset.name}
            fields={fields}
            filter={rows.filter}
            title={rows.title}
            onClose={() => setRows(null)}
          />
        ) : null}
        {result.data ? (
          <div className="flex h-7 shrink-0 items-center gap-2 border-t border-line bg-surface-2 px-3 text-2xs text-fg-muted tabular">
            {t('data.explore.summary', {
              count: result.data.rows.length,
              ms: formatNumber(Math.round(result.data.durationMs), {}, { locale }),
            })}
            {result.data.cached ? ` · ${t('data.explore.cached')}` : ''}
            {result.data.executedOn === 'columnar' ? ` · ${t('data.columnar.executedOn')}` : ''}
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
    mutationFn: () => exploreApi.saveChart(name.trim(), spaceId, spec),
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
    onError: (error) => setFailure(exploreFailure(error).message ?? t('errors.unknown')),
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
