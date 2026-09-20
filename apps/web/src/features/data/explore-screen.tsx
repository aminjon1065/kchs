import { suggestChart } from '@kchs/chart-spec'
import {
  type AskDataResult,
  type ChartSpec,
  type ChartType,
  measureAlias,
  type QueryResult,
} from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import {
  Button,
  Callout,
  Chart,
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
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Save } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { AskBox } from './ask-box.js'
import {
  CHART_TYPES,
  ExplorePlanEditor,
  ResultTable,
  updatePlan,
  useExploreLabels,
  withChannelLabels,
} from './explore-builder.js'
import { type ExploreState, emptyExplore, exploreSpec } from './explore-query.js'
import { datasetQuery } from './queries.js'

const AUTO = '__auto'

type View = 'table' | 'chart'

interface SavedExplore {
  explore?: ExploreState
  view?: View
  chartType?: ChartType | null
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
  const client = useQueryClient()
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
  const { columnLabel, labelled } = useExploreLabels(fields, state, result.data)

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

  const update = (patch: Partial<ExploreState>) => setState((current) => updatePlan(current, patch))

  /**
   * Ответ «Спросить данные»: план — в конструктор (его видно и можно править),
   * результат сервера — в кэш под тем же запросом, чтобы не выполнять его снова.
   */
  const applyAnswer = (answer: AskDataResult) => {
    const next: ExploreState = { datasetId, ...answer.plan }
    client.setQueryData(['explore', JSON.stringify(exploreSpec(next))], answer.result)
    setState(next)
    if (answer.chart === 'table') {
      setView('table')
      setChartType(null)
    } else {
      setView('chart')
      setChartType(answer.chart)
    }
  }
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

        <ExplorePlanEditor
          fields={fields}
          plan={state}
          onChange={update}
          columnLabel={columnLabel}
        />
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
        <AskBox datasetId={datasetId} onAnswer={applyAnswer} />
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
