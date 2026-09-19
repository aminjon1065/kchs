import type {
  FilterNode,
  MetricValue,
  MetricValueInput,
  NotebookBindings,
  QueryResult,
} from '@kchs/contracts'
import { notebookParamFields } from '@kchs/contracts'
import { Chart, NumberTile } from '@kchs/ui'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { metricTileModel, periodText } from '~/features/data/metric-format.js'
import { chartQuery, datasetQuery, metricQuery } from '~/features/data/queries.js'
import { useLabelledResult } from '~/features/gis/result-labels.js'
import { http } from '~/shared/api/client.js'
import { chartQuerySpec, metricPeriod, notebookKeys } from './cell-run.js'
import { useNotebook } from './notebook-context.js'
import { type CellMap, useCellValue, writeCell } from './notebook-doc.js'
import { BindingsControl } from './notebook-params.js'
import { ObjectPicker } from './object-picker.js'
import { CellError, CellResult } from './query-cell.js'

const RESULT_HEIGHT = 320
const NO_BINDINGS: NotebookBindings = {}

/**
 * Ячейка сохранённого графика: его запрос над датасетом получает параметры
 * тетради (ADR-0071); график по сохранённому запросу или показателю строится
 * как есть — ячейка об этом говорит.
 */
export function ChartCell({ cell, cellId }: { cell: CellMap; cellId: string }) {
  const t = useT()
  const { notebookId, spaceId, params, readOnly, timezone } = useNotebook()
  const chartId = useCellValue<string | null>(cell, 'chartId') ?? null
  const bindings = useCellValue<NotebookBindings>(cell, 'bindings') ?? NO_BINDINGS
  const chart = useQuery({ ...chartQuery(chartId ?? ''), enabled: Boolean(chartId), retry: false })
  const spec = chart.data?.spec
  const query = spec && 'query' in spec.data ? spec.data.query : null
  const datasetId = query?.source.kind === 'dataset' ? query.source.id : null
  const dataset = useQuery({
    ...datasetQuery(datasetId ?? ''),
    enabled: Boolean(datasetId),
    retry: false,
  })
  // Запрос над датасетом ждёт схему: без неё параметры не к чему привязать
  const ready = query && (!datasetId || dataset.data || dataset.error)
  const runSpec = ready ? chartQuerySpec(query, dataset.data, params, bindings) : null
  const specKey = runSpec ? JSON.stringify(runSpec) : ''
  const viaQuery = useQuery({
    queryKey: notebookKeys.cell(notebookId, cellId, specKey),
    queryFn: () => http.post<QueryResult>('/queries/run', { spec: runSpec }),
    enabled: Boolean(specKey),
    placeholderData: keepPreviousData,
    retry: false,
  })
  const viaChart = useQuery({
    queryKey: notebookKeys.cell(notebookId, cellId, { chart: chartId }),
    queryFn: () => http.post<QueryResult>(`/charts/${chartId}/data`, {}),
    enabled: Boolean(spec && !query),
    retry: false,
  })
  const result = query ? viaQuery : viaChart
  const labelled = useLabelledResult(result.data)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ObjectPicker
          type="chart"
          value={chartId}
          spaceId={spaceId}
          disabled={readOnly}
          label={t('data.notebook.chart.label')}
          placeholder={t('data.notebook.chart.pick')}
          onChange={(id) => writeCell(cell, { chartId: id, bindings: {} })}
        />
        {dataset.data ? (
          <BindingsControl
            fields={dataset.data.fields}
            bindings={bindings}
            disabled={readOnly}
            onChange={(next) => writeCell(cell, { bindings: next })}
          />
        ) : null}
      </div>
      {spec && !query ? (
        <p className="text-2xs text-fg-muted">{t('data.notebook.chart.noParams')}</p>
      ) : null}
      <CellResult
        missing={chartId ? null : t('data.notebook.chart.pick')}
        error={chart.error ?? (result.data ? null : result.error)}
        pending={result.isFetching}
        result={labelled}
        raw={result.data}
      >
        {spec && labelled ? (
          <Chart
            spec={spec}
            result={labelled}
            height={RESULT_HEIGHT}
            pending={result.isFetching}
            timezone={timezone}
          />
        ) : null}
      </CellResult>
    </div>
  )
}

/**
 * Ячейка показателя: период тетради заменяет период показателя, территория —
 * фильтр по полю территории его датасета; значение — с политиками смотрящего.
 */
export function MetricCell({ cell, cellId }: { cell: CellMap; cellId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { notebookId, spaceId, params, readOnly } = useNotebook()
  const metricId = useCellValue<string | null>(cell, 'metricId') ?? null
  const bindings = useCellValue<NotebookBindings>(cell, 'bindings') ?? NO_BINDINGS
  const metric = useQuery({
    ...metricQuery(metricId ?? ''),
    enabled: Boolean(metricId),
    retry: false,
  })
  const datasetId = metric.data?.datasetId ?? null
  const dataset = useQuery({
    ...datasetQuery(datasetId ?? ''),
    enabled: Boolean(datasetId),
    retry: false,
  })
  const fields = dataset.data
    ? notebookParamFields(bindings, dataset.data.fields, dataset.data.territoryField)
    : null
  const period = metricPeriod(params)
  const filter: FilterNode | null =
    params.territory && fields?.territory
      ? { field: fields.territory, op: 'within', value: params.territory }
      : null
  const input: Partial<MetricValueInput> = {
    ...(period ? { period } : {}),
    ...(filter ? { filter } : {}),
  }
  const value = useQuery({
    queryKey: notebookKeys.cell(notebookId, cellId, { metric: metricId, input }),
    queryFn: () => http.post<MetricValue>(`/metrics/${metricId}/value`, input),
    enabled: Boolean(metric.data && (dataset.data || dataset.error)),
    placeholderData: keepPreviousData,
    retry: false,
  })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ObjectPicker
          type="metric"
          value={metricId}
          spaceId={spaceId}
          disabled={readOnly}
          label={t('data.notebook.metric.label')}
          placeholder={t('data.notebook.metric.pick')}
          onChange={(id) => writeCell(cell, { metricId: id, bindings: {} })}
        />
        {dataset.data ? (
          <BindingsControl
            fields={dataset.data.fields}
            bindings={bindings}
            disabled={readOnly}
            onChange={(next) => writeCell(cell, { bindings: next })}
          />
        ) : null}
      </div>
      {!metricId ? (
        <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-xs text-fg-muted">
          {t('data.notebook.metric.pick')}
        </p>
      ) : metric.error || value.error ? (
        <CellError error={metric.error ?? value.error} />
      ) : value.data ? (
        <NumberTile
          model={metricTileModel(
            value.data,
            t,
            locale,
            `${value.data.name} · ${periodText(value.data.period, t, locale)}`,
          )}
          className="max-w-md"
        />
      ) : (
        <p className="text-xs text-fg-muted">{t('data.explore.running')}</p>
      )}
    </div>
  )
}
