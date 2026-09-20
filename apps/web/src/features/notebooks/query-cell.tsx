import { suggestChart } from '@kchs/chart-spec'
import {
  type AskDataResult,
  type ChartSpec,
  type ChartType,
  type DatasetRecord,
  EMPTY_EXPLORE_PLAN,
  type ExplorePlan,
  type NotebookBindings,
  type QueryResult,
} from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import {
  Button,
  Callout,
  Chart,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Spinner,
  SqlEditor,
  type SqlEditorTable,
  useDebouncedValue,
} from '@kchs/ui'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Settings2, Sparkles } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import type * as Y from 'yjs'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { askError } from '~/features/data/ask-box.js'
import {
  CHART_TYPES,
  ExplorePlanEditor,
  ResultTable,
  updatePlan,
  useExploreLabels,
  withChannelLabels,
} from '~/features/data/explore-builder.js'
import { aiStatusQuery, datasetQuery, sqlSchemaQuery } from '~/features/data/queries.js'
import { ApiError, http } from '~/shared/api/client.js'
import { cellSpec, notebookKeys, sqlParams } from './cell-run.js'
import { useNotebook } from './notebook-context.js'
import { type CellMap, useCellValue, useSharedText, writeCell } from './notebook-doc.js'
import { BindingsControl } from './notebook-params.js'
import { ObjectPicker } from './object-picker.js'

const AUTO = '__auto'
const RESULT_HEIGHT = 320
const SQL_PARAMS = [{ name: 'period_from' }, { name: 'period_to' }, { name: 'territory' }]

/** Ячейка-запрос: визуальный конструктор «Исследования» или SQL (способность data.sql). */
export function QueryCell({ cell, cellId }: { cell: CellMap; cellId: string }) {
  const t = useT()
  const { readOnly, canSql } = useNotebook()
  const mode = useCellValue<'visual' | 'sql'>(cell, 'mode') ?? 'visual'
  return (
    <div className="flex flex-col gap-3">
      {canSql || mode === 'sql' ? (
        <SegmentedControl
          size="sm"
          aria-label={t('data.notebook.query.mode')}
          value={mode}
          onValueChange={(next) => {
            if (!readOnly && (next === 'visual' || canSql)) writeCell(cell, { mode: next })
          }}
          options={[
            { value: 'visual', label: t('data.notebook.query.visual') },
            { value: 'sql', label: t('data.notebook.query.sql') },
          ]}
        />
      ) : null}
      {mode === 'sql' ? (
        <SqlBody cell={cell} cellId={cellId} />
      ) : (
        <VisualBody cell={cell} cellId={cellId} variant="query" />
      )}
    </div>
  )
}

/**
 * Визуальный запрос ячейки: датасет, план конструктора, вид результата. У
 * ИИ-ячейки (`variant="ai"`) план приходит из ответа, датасет выбран над
 * вопросом, а конструктор раскрывает «показать запрос».
 */
function VisualBody({
  cell,
  cellId,
  variant,
}: {
  cell: CellMap
  cellId: string
  variant: 'query' | 'ai'
}) {
  const t = useT()
  const { notebookId, spaceId, params, readOnly, timezone } = useNotebook()
  const datasetId = useCellValue<string | null>(cell, 'datasetId') ?? null
  const plan = useCellValue<ExplorePlan>(cell, 'plan') ?? EMPTY_EXPLORE_PLAN
  const view = useCellValue<'table' | 'chart'>(cell, 'view') ?? 'chart'
  const chartType = useCellValue<ChartType | null>(cell, 'chartType') ?? null
  const bindings = useCellValue<NotebookBindings>(cell, 'bindings') ?? {}
  const [configOpen, setConfigOpen] = useState(variant === 'query' && datasetId === null)
  const { data: dataset, error: datasetError } = useQuery({
    ...datasetQuery(datasetId ?? ''),
    enabled: Boolean(datasetId),
    retry: false,
  })

  const spec = useMemo(
    () => (dataset ? cellSpec(dataset, plan, params, bindings) : null),
    [dataset, plan, params, bindings],
  )
  const specKey = useDebouncedValue(spec ? JSON.stringify(spec) : '', 400)
  const result = useQuery({
    queryKey: notebookKeys.cell(notebookId, cellId, specKey),
    queryFn: () => http.post<QueryResult>('/queries/run', { spec: JSON.parse(specKey) }),
    enabled: Boolean(specKey),
    placeholderData: keepPreviousData,
    retry: false,
  })
  const fields = dataset?.fields ?? NO_FIELDS
  const { columnLabel, labelled } = useExploreLabels(fields, plan, result.data)
  const chartSpec = useMemo<ChartSpec | null>(() => {
    if (!labelled || !specKey) return null
    return withChannelLabels(
      suggestChart(labelled, { query: JSON.parse(specKey) }, chartType ? { type: chartType } : {}),
      labelled,
    )
  }, [labelled, specKey, chartType])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {variant === 'query' ? (
          <ObjectPicker
            type="dataset"
            value={datasetId}
            spaceId={spaceId}
            disabled={readOnly}
            label={t('data.notebook.query.dataset')}
            placeholder={t('data.notebook.query.pickDataset')}
            onChange={(id) =>
              writeCell(cell, {
                datasetId: id,
                plan: EMPTY_EXPLORE_PLAN,
                bindings: {},
                chartType: null,
              })
            }
          />
        ) : null}
        <SegmentedControl
          size="sm"
          aria-label={t('data.notebook.query.view')}
          value={view}
          onValueChange={(next) => !readOnly && writeCell(cell, { view: next })}
          options={[
            { value: 'chart', label: t('data.explore.view.chart') },
            { value: 'table', label: t('data.explore.view.table') },
          ]}
        />
        {view === 'chart' ? (
          <Select
            value={chartType ?? AUTO}
            disabled={readOnly}
            onValueChange={(next) => writeCell(cell, { chartType: next === AUTO ? null : next })}
          >
            <SelectTrigger aria-label={t('data.explore.chartType')} className="h-7 w-36 text-xs">
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
        {dataset ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<Settings2 className="size-3.5" />}
            aria-expanded={configOpen}
            onClick={() => setConfigOpen((open) => !open)}
          >
            {variant === 'ai'
              ? t(configOpen ? 'data.ask.hideQuery' : 'data.ask.showQuery')
              : t(
                  configOpen
                    ? 'data.notebook.query.hideConfigure'
                    : 'data.notebook.query.configure',
                )}
          </Button>
        ) : null}
      </div>

      {configOpen && dataset ? (
        <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-2 p-3">
          <fieldset disabled={readOnly} className="m-0 min-w-0 border-0 p-0">
            <legend className="sr-only">{t('data.notebook.query.configure')}</legend>
            <ExplorePlanEditor
              fields={fields}
              plan={plan}
              columnLabel={columnLabel}
              compact
              onChange={(patch) => writeCell(cell, { plan: updatePlan(plan, patch) })}
            />
          </fieldset>
          <BindingsControl
            fields={fields}
            bindings={bindings}
            disabled={readOnly}
            onChange={(next) => writeCell(cell, { bindings: next })}
          />
        </div>
      ) : null}

      <CellResult
        missing={datasetId ? null : t('data.notebook.query.pickDataset')}
        error={datasetError ?? (result.data ? null : result.error)}
        pending={result.isFetching}
        result={labelled}
        raw={result.data}
      >
        {labelled ? (
          view === 'chart' && chartSpec ? (
            <Chart
              spec={chartSpec}
              result={labelled}
              height={RESULT_HEIGHT}
              pending={result.isFetching}
              timezone={timezone}
            />
          ) : (
            <ResultTable result={labelled} className="h-80 flex-none" />
          )
        ) : null}
      </CellResult>
    </div>
  )
}

const NO_FIELDS: DatasetRecord['fields'] = []

/** SQL-ячейка: текст правится совместно (Y.Text), выполняется по кнопке или Ctrl+Enter. */
function SqlBody({ cell, cellId }: { cell: CellMap; cellId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { notebookId, params, readOnly, canSql, timezone } = useNotebook()
  const [sql, setSql] = useSharedText(cell.get('sql') as Y.Text | undefined)
  // Выполняется то, что отправили: правка текста не перезапускает запрос на каждую букву
  const [submitted, setSubmitted] = useState(sql)
  const { data: schema } = useQuery({ ...sqlSchemaQuery(), enabled: canSql })
  const tables = useMemo<SqlEditorTable[]>(
    () =>
      (schema?.tables ?? []).map((table) => ({
        name: table.name,
        ...(table.space ? { description: table.space } : {}),
        columns: table.columns.map((column) => ({
          key: column.key,
          label: column.label[locale] ?? column.label.ru ?? column.key,
          type: t(`data.types.${column.type}`),
        })),
      })),
    [schema, locale, t],
  )
  const values = useMemo(() => sqlParams(params, timezone), [params, timezone])
  const result = useQuery({
    queryKey: notebookKeys.cell(notebookId, cellId, { sql: submitted, values }),
    queryFn: () => http.post<QueryResult>('/sql/run', { sql: submitted, params: values }),
    enabled: canSql && Boolean(submitted.trim()),
    placeholderData: keepPreviousData,
    retry: false,
  })

  // Без способности data.sql запрос виден, но не выполняется (сервер его и не выполнит)
  if (!canSql) {
    return (
      <div className="flex flex-col gap-2">
        <SqlEditor
          value={sql}
          readOnly
          aria-label={t('data.notebook.query.sqlEditor')}
          minHeight={64}
          maxHeight={200}
        />
        <Callout tone="info">{t('data.notebook.query.noSql')}</Callout>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <SqlEditor
        value={sql}
        onChange={(next) => !readOnly && setSql(next)}
        onRun={(value) => setSubmitted(value)}
        schema={tables}
        params={SQL_PARAMS}
        readOnly={readOnly}
        placeholder={t('data.sql.placeholder')}
        aria-label={t('data.notebook.query.sqlEditor')}
        minHeight={96}
        maxHeight={280}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<Play className="size-3.5" />}
          disabled={!sql.trim()}
          loading={result.isFetching}
          onClick={() => {
            if (sql === submitted) void result.refetch()
            else setSubmitted(sql)
          }}
        >
          {t('data.notebook.query.runSql')}
        </Button>
        <span className="text-2xs text-fg-muted">{t('data.notebook.query.sqlHint')}</span>
      </div>
      <CellResult
        missing={submitted.trim() ? null : t('data.notebook.query.sqlEmpty')}
        error={result.data ? null : result.error}
        pending={result.isFetching}
        result={result.data}
        raw={result.data}
      >
        {result.data ? <ResultTable result={result.data} className="h-80 flex-none" /> : null}
      </CellResult>
    </div>
  )
}

/**
 * ИИ-ячейка (ADR-0061, ADR-0071): вопрос к датасету → план «Спросить данные» с
 * графиком; «показать запрос» раскрывает конструктор — дальше план правится,
 * как в ячейке-запросе. Вопрос и ответ видят все соавторы.
 */
export function AiCell({ cell, cellId }: { cell: CellMap; cellId: string }) {
  const t = useT()
  const client = useQueryClient()
  const { spaceId, readOnly } = useNotebook()
  const { data: status } = useQuery(aiStatusQuery())
  const datasetId = useCellValue<string | null>(cell, 'datasetId') ?? null
  const question = useCellValue<string>(cell, 'question') ?? ''
  const answer = useCellValue<{ title: string; explanation: string } | null>(cell, 'answer')
  const [draft, setDraft] = useState(question)
  const [shownQuestion, setShownQuestion] = useState(question)
  // Вопрос соавтора (или свой, записанный с ответом) — в поле
  if (question !== shownQuestion) {
    setShownQuestion(question)
    setDraft(question)
  }

  const ask = useMutation({
    mutationFn: (text: string) =>
      http.post<AskDataResult>(`/datasets/${datasetId}/ask`, { question: text }),
    onSuccess: (result, text) => {
      writeCell(cell, {
        // Подпись ячейки (оглавление) — название ответа, если своей нет
        ...(cell.get('title') ? {} : { title: result.title.slice(0, 200) }),
        question: text,
        answer: {
          title: result.title.slice(0, 200),
          explanation: result.explanation.slice(0, 2000),
        },
        plan: result.plan,
        view: result.chart === 'table' ? 'table' : 'chart',
        chartType: result.chart === 'table' ? null : result.chart,
      })
    },
    onSettled: () => void client.invalidateQueries({ queryKey: aiStatusQuery().queryKey }),
  })
  const error = ask.error ? askError(ask.error, t) : null
  const trimmed = draft.trim()
  const enabled = Boolean(status?.enabled)

  return (
    <div className="flex flex-col gap-3">
      <ObjectPicker
        type="dataset"
        value={datasetId}
        spaceId={spaceId}
        disabled={readOnly}
        label={t('data.notebook.query.dataset')}
        placeholder={t('data.notebook.query.pickDataset')}
        onChange={(id) =>
          writeCell(cell, { datasetId: id, plan: EMPTY_EXPLORE_PLAN, bindings: {}, answer: null })
        }
      />
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (trimmed.length >= 3 && datasetId) ask.mutate(trimmed)
        }}
      >
        <Input
          aria-label={t('data.notebook.ai.question')}
          placeholder={t('data.notebook.ai.placeholder')}
          maxLength={500}
          value={draft}
          disabled={readOnly || !enabled}
          onChange={(event) => setDraft(event.target.value)}
          className="min-w-0 flex-1"
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          icon={<Sparkles className="size-3.5" />}
          loading={ask.isPending}
          disabled={readOnly || !enabled || !datasetId || trimmed.length < 3}
        >
          {t('data.notebook.ai.ask')}
        </Button>
      </form>
      {enabled ? null : <p className="text-xs text-fg-muted">{t('data.notebook.ai.disabled')}</p>}
      {error && !ask.isPending ? (
        <Callout tone="danger" title={error.title}>
          {error.detail}
        </Callout>
      ) : null}
      {answer ? (
        <>
          <p className="text-xs text-fg-secondary">
            <span className="font-medium text-fg">{t('data.ask.understood')}: </span>
            {answer.explanation}
          </p>
          <VisualBody cell={cell} cellId={cellId} variant="ai" />
        </>
      ) : null}
    </div>
  )
}

/** Результат ячейки: выбор источника, ошибка, «нет доступа», загрузка, подвал со временем. */
export function CellResult({
  missing,
  error,
  pending,
  result,
  raw,
  children,
}: {
  missing: string | null
  error: unknown
  pending: boolean
  result: QueryResult | undefined
  raw: QueryResult | undefined
  children: ReactNode
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  if (missing) {
    return (
      <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-xs text-fg-muted">
        {missing}
      </p>
    )
  }
  if (error) return <CellError error={error} />
  if (!result) {
    return pending ? (
      <div className="flex items-center gap-2 text-xs text-fg-secondary">
        <Spinner className="size-3" />
        {t('data.explore.running')}
      </div>
    ) : (
      <Skeleton className="h-40 w-full" />
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      {raw?.truncated ? (
        <Callout tone="warning">{t('data.explore.truncated', { count: raw.rows.length })}</Callout>
      ) : null}
      {children}
      {raw ? (
        <p className="flex items-center gap-2 text-2xs text-fg-muted tabular">
          {t('data.explore.summary', {
            count: raw.rows.length,
            ms: formatNumber(Math.round(raw.durationMs), {}, { locale }),
          })}
          {raw.cached ? ` · ${t('data.explore.cached')}` : ''}
          {raw.executedOn === 'columnar' ? ` · ${t('data.columnar.executedOn')}` : ''}
          {pending ? <Spinner className="size-3" /> : null}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Ошибка ячейки: нет доступа к источнику или его данным (права по ссылкам не
 * наследуются) — «нет доступа», иначе — сообщение сервера.
 */
export function CellError({ error }: { error: unknown }) {
  const t = useT()
  const denied = error instanceof ApiError && (error.status === 403 || error.status === 404)
  return (
    <Callout
      tone={denied ? 'warning' : 'danger'}
      title={denied ? t('data.notebook.noAccess') : t('data.notebook.failed')}
    >
      {!denied && error instanceof ApiError ? error.message : null}
    </Callout>
  )
}
