import { suggestChart } from '@kchs/chart-spec'
import {
  type ChartSpec,
  type DatasetRecord,
  type FilterNode,
  type MetricValue,
  type MetricValueInput,
  notebookParamFields,
  type QueryResult,
  type QuerySpec,
  REPORT_FIGURE_HEIGHT,
  type ReportBlock,
  type ReportPrintBlock,
} from '@kchs/contracts'
import {
  Chart,
  ChartTable,
  MapCanvas,
  type MapInstance,
  MapLegend,
  NumberTile,
  RichTextEditor,
  renderMapIcon,
  useMapTheme,
} from '@kchs/ui'
import { useQueries, useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useExploreLabels, withChannelLabels } from '~/features/data/explore-builder.js'
import { metricTileModel, periodText } from '~/features/data/metric-format.js'
import { chartQuery, datasetQuery, metricQuery } from '~/features/data/queries.js'
import { registerPmtilesProtocol } from '~/features/gis/basemaps.js'
import { useLabelledResult } from '~/features/gis/result-labels.js'
import { cellSpec, chartQuerySpec, metricPeriod, sqlParams } from '~/features/notebooks/cell-run.js'
import { ApiError, http } from '~/shared/api/client.js'
import { useReportMap } from '../report-map.js'
import { type PrintTable, printTable, usePrint, useReportReady } from './print-context.js'

type BlockOf<K extends ReportBlock['kind']> = Extract<ReportBlock, { kind: K }>

/** Не дольше этого карта ждёт тайлов: дальше снимается то, что успело нарисоваться. */
const MAP_IDLE_TIMEOUT_MS = 45_000
const NO_FIELDS: DatasetRecord['fields'] = []

const noticeText = (error: unknown, t: ReturnType<typeof useT>): string =>
  error instanceof ApiError && (error.status === 403 || error.status === 404)
    ? t('data.report.print.noAccess')
    : error instanceof ApiError
      ? error.message
      : t('data.report.print.failed')

/** Подпись блока над содержимым (у текста — нет). */
function Caption({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-semibold text-fg">{children}</h2>
}

/** Блок, которому нечего показать: нет доступа, ошибка, пусто — текстом. */
function Notice({
  block,
  title,
  text,
}: {
  block: ReportBlock
  title: string | null
  text: string
}) {
  const model = useMemo<ReportPrintBlock[]>(
    () => [{ id: block.id, kind: 'notice', title, text }],
    [block.id, title, text],
  )
  useReportReady(block.id, model)
  return (
    <section className="flex flex-col gap-1.5 break-inside-avoid">
      {title ? <Caption>{title}</Caption> : null}
      <p className="rounded-md border border-dashed border-line px-3 py-3 text-xs text-fg-muted">
        {text}
      </p>
    </section>
  )
}

/** Таблица печати: вся, без прокрутки, строк — не больше `maxRows` блока. */
function TableFigure({
  block,
  title,
  table,
}: {
  block: ReportBlock
  title: string | null
  table: PrintTable
}) {
  const t = useT()
  const model = useMemo<ReportPrintBlock[]>(
    () => [
      {
        id: block.id,
        kind: 'table',
        title,
        columns: table.columns.map(({ label, numeric }) => ({ label, numeric })),
        rows: table.rows,
        total: table.total,
      },
    ],
    [block.id, title, table],
  )
  useReportReady(block.id, model)
  return (
    <section className="flex flex-col gap-1.5">
      {title ? <Caption>{title}</Caption> : null}
      {table.rows.length === 0 ? (
        <p className="text-xs text-fg-muted">{t('data.report.print.empty')}</p>
      ) : (
        <ChartTable
          model={{
            caption: title ?? '',
            columns: table.columns,
            rows: table.rows,
            total: table.total,
          }}
          maxHeight={1_000_000}
        />
      )}
    </section>
  )
}

/** График печати: без анимации, картинка для DOCX снимается с `data-print-figure`. */
function ChartFigure({
  block,
  title,
  spec,
  result,
  height,
}: {
  block: ReportBlock
  title: string | null
  spec: ChartSpec
  result: QueryResult
  height: number
}) {
  const { timezone } = usePrint()
  const model = useMemo<ReportPrintBlock[]>(
    () => [{ id: block.id, kind: 'figure', title, figure: 'chart', note: null }],
    [block.id, title],
  )
  useReportReady(block.id, model)
  return (
    <section className="flex flex-col gap-1.5 break-inside-avoid">
      {title ? <Caption>{title}</Caption> : null}
      <figure data-print-figure={block.id} className="m-0 bg-surface">
        <Chart spec={spec} result={result} height={height} animation={false} timezone={timezone} />
      </figure>
    </section>
  )
}

export function PrintText({ block }: { block: BlockOf<'text'> }) {
  const t = useT()
  const model = useMemo<ReportPrintBlock[]>(
    () => [{ id: block.id, kind: 'text', body: block.body }],
    [block.id, block.body],
  )
  useReportReady(block.id, model)
  return (
    <section className="break-inside-auto">
      <RichTextEditor
        value={block.body}
        editable={false}
        toolbar="none"
        aria-label={block.title ?? t('data.report.kinds.text')}
      />
    </section>
  )
}

export function PrintPageBreak({ block }: { block: BlockOf<'page_break'> }) {
  const model = useMemo<ReportPrintBlock[]>(
    () => [{ id: block.id, kind: 'page_break' }],
    [block.id],
  )
  useReportReady(block.id, model)
  return <div aria-hidden className="break-before-page" />
}

/**
 * Запрос: визуальный (план «Исследования» с параметрами отчёта) или SQL —
 * таблицей или графиком, с правами того, под кем строится отчёт.
 */
export function PrintQuery({ block }: { block: BlockOf<'query'> }) {
  const t = useT()
  const { params, timezone, locale, canSql } = usePrint()
  const sql = block.mode === 'sql'
  const dataset = useQuery({
    ...datasetQuery(block.datasetId ?? ''),
    enabled: !sql && Boolean(block.datasetId),
    retry: false,
  })
  const spec = useMemo<QuerySpec | null>(() => {
    if (sql || !dataset.data) return null
    const base = cellSpec(dataset.data, block.plan, params, block.bindings)
    // Таблица отчёта — с ограничением строк: сервер не отдаёт больше нужного
    return block.view === 'table'
      ? { ...base, steps: [...base.steps, { type: 'limit', limit: block.maxRows, offset: 0 }] }
      : base
  }, [sql, dataset.data, block.plan, block.bindings, block.view, block.maxRows, params])
  const visual = useQuery({
    queryKey: ['print', 'query', block.id, spec],
    queryFn: () => http.post<QueryResult>('/queries/run', { spec }),
    enabled: Boolean(spec),
    retry: false,
  })
  const values = useMemo(() => sqlParams(params, timezone), [params, timezone])
  const raw = useQuery({
    queryKey: ['print', 'sql', block.id, block.sql, values],
    queryFn: () => http.post<QueryResult>('/sql/run', { sql: block.sql, params: values }),
    enabled: sql && canSql && Boolean(block.sql.trim()),
    retry: false,
  })
  const result = sql ? raw : visual
  const fields = dataset.data?.fields ?? NO_FIELDS
  const { labelled } = useExploreLabels(fields, block.plan, sql ? undefined : result.data)
  const shown = sql ? result.data : labelled
  const chartSpec = useMemo<ChartSpec | null>(() => {
    if (sql || block.view !== 'chart' || !labelled || !spec) return null
    return withChannelLabels(
      suggestChart(labelled, { query: spec }, block.chartType ? { type: block.chartType } : {}),
      labelled,
    )
  }, [sql, block.view, labelled, spec, block.chartType])
  const table = useMemo(
    () =>
      shown && (sql || block.view === 'table')
        ? printTable(shown, { locale, timezone, maxRows: block.maxRows })
        : null,
    [shown, sql, block.view, locale, timezone, block.maxRows],
  )

  const title = block.title
  if (sql && !canSql)
    return <Notice block={block} title={title} text={t('data.report.print.noSql')} />
  if (sql ? !block.sql.trim() : !block.datasetId) {
    return <Notice block={block} title={title} text={t('data.report.print.noSource')} />
  }
  const error = dataset.error ?? result.error
  if (error) return <Notice block={block} title={title} text={noticeText(error, t)} />
  if (chartSpec && labelled) {
    return (
      <ChartFigure
        block={block}
        title={title}
        spec={chartSpec}
        result={labelled}
        height={REPORT_FIGURE_HEIGHT[block.size]}
      />
    )
  }
  if (table) return <TableFigure block={block} title={title} table={table} />
  return <Loading />
}

/** Сохранённый график: графиком или таблицей его данных; параметры — к запросу над датасетом. */
export function PrintChart({ block }: { block: BlockOf<'chart'> }) {
  const t = useT()
  const { params, locale, timezone } = usePrint()
  const chart = useQuery({
    ...chartQuery(block.chartId ?? ''),
    enabled: Boolean(block.chartId),
    retry: false,
  })
  const spec = chart.data?.spec
  const query = spec && 'query' in spec.data ? spec.data.query : null
  const datasetId = query?.source.kind === 'dataset' ? query.source.id : null
  const dataset = useQuery({
    ...datasetQuery(datasetId ?? ''),
    enabled: Boolean(datasetId),
    retry: false,
  })
  const ready = query && (!datasetId || dataset.data || dataset.error)
  const runSpec = ready ? chartQuerySpec(query, dataset.data, params, block.bindings) : null
  const viaQuery = useQuery({
    queryKey: ['print', 'chart', block.id, runSpec],
    queryFn: () => http.post<QueryResult>('/queries/run', { spec: runSpec }),
    enabled: Boolean(runSpec),
    retry: false,
  })
  const viaChart = useQuery({
    queryKey: ['print', 'chart-data', block.id, block.chartId],
    queryFn: () => http.post<QueryResult>(`/charts/${block.chartId}/data`, {}),
    enabled: Boolean(spec && !query),
    retry: false,
  })
  const result = query ? viaQuery : viaChart
  const labelled = useLabelledResult(result.data)
  const title = block.title ?? chart.data?.name ?? null
  const table = useMemo(
    () =>
      labelled && block.view === 'table'
        ? printTable(labelled, { locale, timezone, maxRows: 1000 })
        : null,
    [labelled, block.view, locale, timezone],
  )

  if (!block.chartId) {
    return <Notice block={block} title={title} text={t('data.report.print.noSource')} />
  }
  const error = chart.error ?? result.error
  if (error) return <Notice block={block} title={title} text={noticeText(error, t)} />
  if (!spec || !labelled) return <Loading />
  if (table) return <TableFigure block={block} title={title} table={table} />
  return (
    <ChartFigure
      block={block}
      title={title}
      spec={spec}
      result={labelled}
      height={REPORT_FIGURE_HEIGHT[block.size]}
    />
  )
}

/**
 * Сетка показателей: период отчёта заменяет период показателя, территория —
 * фильтр по полю территории его датасета (как в тетради).
 */
export function PrintMetrics({ block }: { block: BlockOf<'metrics'> }) {
  const t = useT()
  const { params, locale } = usePrint()
  const metrics = useQueries({
    queries: block.metricIds.map((id) => ({ ...metricQuery(id), retry: false })),
  })
  const datasets = useQueries({
    queries: metrics.map((metric) => ({
      ...datasetQuery(metric.data?.datasetId ?? ''),
      enabled: Boolean(metric.data?.datasetId),
      retry: false,
    })),
  })
  const inputs = metrics.map((metric, index) => {
    const dataset = datasets[index]?.data
    const fields = dataset
      ? notebookParamFields(block.bindings, dataset.fields, dataset.territoryField)
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
    return {
      id: block.metricIds[index] as string,
      ready: Boolean(metric.data && (datasets[index]?.data || datasets[index]?.error)),
      input,
      error: metric.error,
    }
  })
  const values = useQueries({
    queries: inputs.map((item) => ({
      queryKey: ['print', 'metric', block.id, item.id, item.input],
      queryFn: () => http.post<MetricValue>(`/metrics/${item.id}/value`, item.input),
      enabled: item.ready,
      retry: false,
    })),
  })
  const done = values.every((value, index) => value.data || value.error || inputs[index]?.error)
  const tiles = values.map((value, index) => ({
    id: inputs[index]?.id ?? String(index),
    error: inputs[index]?.error ?? value.error,
    model: value.data
      ? metricTileModel(
          value.data,
          t,
          locale,
          `${value.data.name} · ${periodText(value.data.period, t, locale)}`,
        )
      : null,
  }))
  // biome-ignore lint/correctness/useExhaustiveDependencies: модель — по готовности значений
  const model = useMemo<ReportPrintBlock[] | null>(
    () =>
      done
        ? [
            {
              id: block.id,
              kind: 'metrics',
              title: block.title,
              items: tiles.map((tile) =>
                tile.model
                  ? {
                      label: tile.model.label,
                      value: [tile.model.formatted, tile.model.unit].filter(Boolean).join(' '),
                      note: tile.model.delta
                        ? `${tile.model.delta.formatted} ${tile.model.delta.label}`
                        : '',
                    }
                  : { label: '', value: '—', note: noticeText(tile.error, t) },
              ),
            },
          ]
        : null,
    [done, block.id, block.title, values.map((value) => value.dataUpdatedAt).join(',')],
  )
  useReportReady(block.id, model)

  if (block.metricIds.length === 0) {
    return <Notice block={block} title={block.title} text={t('data.report.print.noSource')} />
  }
  return (
    <section className="flex flex-col gap-1.5 break-inside-avoid">
      {block.title ? <Caption>{block.title}</Caption> : null}
      <div className="grid grid-cols-2 gap-3">
        {tiles.map((tile) =>
          tile.model ? (
            <NumberTile key={tile.id} model={tile.model} />
          ) : tile.error ? (
            <p
              key={tile.id}
              className="rounded-md border border-dashed border-line px-3 py-3 text-xs text-fg-muted"
            >
              {noticeText(tile.error, t)}
            </p>
          ) : (
            <Loading key={tile.id} />
          ),
        )}
      </div>
    </section>
  )
}

/**
 * Карта печати: MapCanvas без взаимодействия; когда MapLibre дорисовал тайлы
 * (`data-map-state="idle"`), кадр переносится в картинку — WebGL-холст в PDF
 * печатается ненадёжно, а картинка — и в PDF, и в DOCX. Легенда и атрибуция
 * подложки — текстом под картой.
 */
export function PrintMap({ block }: { block: BlockOf<'map'> }) {
  const t = useT()
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const theme = useMapTheme(root)
  const state = useReportMap(block, theme)
  const [instance, setInstance] = useState<MapInstance | null>(null)
  const [image, setImage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const holder = useRef<HTMLDivElement>(null)
  const height = REPORT_FIGURE_HEIGHT[block.size]
  const fit = useMemo(() => (state.fit ? { bbox: state.fit, key: 'fit' } : null), [state.fit])

  // Кадр готов: MapLibre в покое после добавления слоёв — снять холст в картинку
  useEffect(() => {
    if (!instance || image || failed || state.loading) return
    let stopped = false
    const started = Date.now()
    const capture = () => {
      instance.once('render', () => {
        if (stopped) return
        try {
          setImage(instance.getCanvas().toDataURL('image/png'))
        } catch {
          setFailed(true)
        }
      })
      instance.triggerRepaint()
    }
    const timer = window.setInterval(() => {
      const mapState = holder.current
        ?.querySelector('[data-map-state]')
        ?.getAttribute('data-map-state')
      if (mapState === 'failed') {
        window.clearInterval(timer)
        setFailed(true)
      } else if (mapState === 'idle' || Date.now() - started > MAP_IDLE_TIMEOUT_MS) {
        window.clearInterval(timer)
        capture()
      }
    }, 150)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [instance, image, failed, state.loading])

  const note =
    state.hiddenLayers > 0
      ? t('data.report.print.hiddenLayers', { count: state.hiddenLayers })
      : null
  const model = useMemo<ReportPrintBlock[] | null>(
    () =>
      image ? [{ id: block.id, kind: 'figure', title: block.title, figure: 'map', note }] : null,
    [image, block.id, block.title, note],
  )
  useReportReady(block.id, model)

  if (state.missing) {
    return <Notice block={block} title={block.title} text={t('data.report.print.noSource')} />
  }
  if (state.denied) {
    return <Notice block={block} title={block.title} text={t('data.report.print.noAccess')} />
  }
  if (failed) {
    return <Notice block={block} title={block.title} text={t('data.report.print.mapFailed')} />
  }
  return (
    <section ref={setRoot} className="flex flex-col gap-1.5 break-inside-avoid">
      {block.title ? <Caption>{block.title}</Caption> : null}
      <figure
        data-print-figure={image ? block.id : undefined}
        className="m-0 flex flex-col gap-2 bg-surface"
      >
        {image ? (
          <img src={image} alt={block.title ?? t('data.report.kinds.map')} className="w-full" />
        ) : (
          <div ref={holder} className="relative w-full" style={{ height }}>
            {state.loading ? null : (
              <MapCanvas
                className="absolute inset-0"
                basemapStyle={state.basemapStyle}
                prepare={registerPmtilesProtocol}
                sources={state.rendered.sources}
                layers={state.rendered.layers}
                images={state.rendered.images}
                camera={state.camera}
                fitBounds={fit}
                staticView
                onMapReady={setInstance}
                aria-label={block.title ?? t('data.report.kinds.map')}
              />
            )}
          </div>
        )}
        {block.legend && state.legends.length > 0 ? (
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            {state.legends.map((legend, index) => (
              // Легенды слоёв карты неизменяемы и без идентификаторов — индекс устойчив
              <MapLegend key={index} legend={legend} renderIcon={renderMapIcon} />
            ))}
          </div>
        ) : null}
        {state.attribution.length > 0 ? (
          <figcaption className="text-2xs text-fg-muted">
            {state.attribution.join(' · ')}
          </figcaption>
        ) : null}
        {note ? <p className="text-2xs text-fg-muted">{note}</p> : null}
      </figure>
    </section>
  )
}

function Loading() {
  return <div aria-hidden className="h-24 w-full animate-pulse-soft rounded-md bg-surface-3" />
}
