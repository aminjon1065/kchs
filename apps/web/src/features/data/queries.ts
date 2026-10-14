import type {
  FieldOption,
  ImportStatus,
  JobStatus,
  MetricValueInput,
  QueryResult,
  SYSTEM_DATASETS,
} from '@kchs/contracts'
import { IMPORT_FINAL_STATUSES } from '@kchs/contracts'
import { queryOptions, skipToken } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

/** Ключи кэша модуля «Данные»: `['dataset', id, …]`, `['import', id]`. */
export const dataKeys = {
  dataset: (id: string) => ['dataset', id] as const,
  versions: (id: string) => ['dataset', id, 'versions'] as const,
  imports: (id: string) => ['dataset', id, 'imports'] as const,
  policies: (id: string) => ['dataset', id, 'policies'] as const,
  columnar: (id: string) => ['dataset', id, 'columnar'] as const,
  row: (id: string, rowId: string) => ['dataset', id, 'row', rowId] as const,
  rowHistory: (id: string, rowId: string) => ['dataset', id, 'row', rowId, 'history'] as const,
  profile: (id: string, key: string) => ['dataset', id, 'profile', key] as const,
  import: (id: string) => ['import', id] as const,
  chart: (id: string) => ['chart', id] as const,
  chartData: (id: string) => ['chart', id, 'data'] as const,
  dashboard: (id: string) => ['dashboard', id] as const,
  metric: (id: string) => ['metric', id] as const,
  metricValue: (id: string, input: Partial<MetricValueInput>) =>
    ['metric', id, 'value', input] as const,
  dashboardData: (id: string, filters: Record<string, unknown>) =>
    ['dashboard', id, 'data', filters] as const,
}

/** ИИ для пользователя: без провайдера или способности `ai.use` поле вопроса скрыто. */
export const aiStatusQuery = () =>
  queryOptions({
    queryKey: ['ai', 'status'] as const,
    queryFn: () => http.get('/ai/status'),
    staleTime: 60_000,
  })

export const datasetQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.dataset(id),
    queryFn: () => http.get('/datasets/:id', { params: { id } }),
  })

/** Схема системного датасета — подписи полей показателя над ним (ADR-0082). */
export const systemDatasetQuery = (name: (typeof SYSTEM_DATASETS)[number] | null) =>
  queryOptions({
    queryKey: ['system-dataset', name] as const,
    queryFn: name ? () => http.get('/system-datasets/:name', { params: { name } }) : skipToken,
    staleTime: 5 * 60_000,
  })

/** Колоночная копия датасета (ADR-0109): состояние и метаданные. */
export const columnarCopyQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.columnar(id),
    queryFn: () => http.get('/datasets/:id/columnar', { params: { id } }),
  })

export const datasetVersionsQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.versions(id),
    queryFn: async () => (await http.get('/datasets/:id/versions', { params: { id } })).items,
  })

export const datasetImportsQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.imports(id),
    queryFn: async () => (await http.get('/datasets/:id/imports', { params: { id } })).items,
    // Идущий импорт (например, опубликованный после сводки изменений) — до его завершения
    refetchInterval: (query) =>
      query.state.data?.some((item) => !isImportFinished(item.status) && item.status !== 'review')
        ? 2000
        : false,
  })

/** Датасеты и поля для подсказок SQL-лаборатории (способность `data.sql`). */
export const sqlSchemaQuery = () =>
  queryOptions({
    queryKey: ['sql', 'schema'] as const,
    queryFn: () => http.get('/sql/schema'),
    staleTime: 60_000,
  })

/** Строка по `_id` — с политиками пользователя, как в таблице. */
export const datasetRowQuery = (id: string, rowId: string) =>
  queryOptions({
    queryKey: dataKeys.row(id, rowId),
    queryFn: () => http.get('/datasets/:id/rows/:rowId', { params: { id, rowId } }),
  })

/** История строки: при ограничениях политики сервер отказывает (403) — без повторов. */
export const rowHistoryQuery = (id: string, rowId: string) =>
  queryOptions({
    queryKey: dataKeys.rowHistory(id, rowId),
    queryFn: async () =>
      (await http.get('/datasets/:id/rows/:rowId/history', { params: { id, rowId } })).items,
    retry: false,
  })

/** Политики строк и столбцов — только для `manage+`. */
export const datasetPoliciesQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.policies(id),
    queryFn: () => http.get('/datasets/:id/policies', { params: { id } }),
  })

/** Больше строк справочника — подписи не подставляются (в ячейках остаются ключи). */
export const LOOKUP_OPTIONS_LIMIT = 2000

export interface LookupRef {
  datasetId: string
  keyField: string
  labelField: string
}

/**
 * Подписи справочника поля: ключ → подпись по строкам, которые видит
 * пользователь. Справочник недоступен или слишком велик — вариантов нет.
 */
export const lookupOptionsQuery = (lookup: LookupRef) =>
  queryOptions({
    queryKey: [
      ...dataKeys.dataset(lookup.datasetId),
      'lookup',
      lookup.keyField,
      lookup.labelField,
    ] as const,
    queryFn: async (): Promise<FieldOption[]> => {
      const fields = [...new Set([lookup.keyField, lookup.labelField])]
      const result = await http.post('/queries/run', {
        body: {
          spec: {
            version: 1,
            source: { kind: 'dataset', id: lookup.datasetId },
            steps: [
              { type: 'select', fields },
              { type: 'limit', limit: LOOKUP_OPTIONS_LIMIT + 1, offset: 0 },
            ],
          },
        },
      })
      if (result.rows.length > LOOKUP_OPTIONS_LIMIT) return []
      return lookupPairs(lookup, result)
    },
    staleTime: 60_000,
    retry: false,
  })

/** Строк поиска по большому справочнику в выпадающем списке. */
const LOOKUP_SEARCH_LIMIT = 50

/** Пары «ключ — подпись» из результата запроса к справочнику. */
function lookupPairs(lookup: LookupRef, result: QueryResult): FieldOption[] {
  const keyIndex = result.fields.findIndex((field) => field.name === lookup.keyField)
  const labelIndex = result.fields.findIndex((field) => field.name === lookup.labelField)
  return result.rows.flatMap((row) => {
    const key = row[keyIndex]
    const label = row[labelIndex]
    if (key === null || key === undefined || label === null || label === undefined) return []
    return [{ value: String(key), label: { ru: String(label) } }]
  })
}

/**
 * Поиск по справочнику, который больше `LOOKUP_OPTIONS_LIMIT` (ADR-0129): по
 * подстроке подписи или точному ключу, первые строки — на пустой запрос.
 */
export const lookupSearchQuery = (lookup: LookupRef, q: string) =>
  queryOptions({
    queryKey: [
      ...dataKeys.dataset(lookup.datasetId),
      'lookup-search',
      lookup.keyField,
      lookup.labelField,
      q,
    ] as const,
    queryFn: async (): Promise<FieldOption[]> => {
      const fields = [...new Set([lookup.keyField, lookup.labelField])]
      const result = await http.post('/queries/run', {
        body: {
          spec: {
            version: 1,
            source: { kind: 'dataset', id: lookup.datasetId },
            steps: [
              ...(q
                ? [
                    {
                      type: 'filter' as const,
                      where: {
                        or: [
                          { field: lookup.labelField, op: 'contains', value: q },
                          { field: lookup.keyField, op: 'eq', value: q },
                        ],
                      },
                    },
                  ]
                : []),
              { type: 'select' as const, fields },
              { type: 'limit' as const, limit: LOOKUP_SEARCH_LIMIT, offset: 0 },
            ],
          },
        },
      })
      return lookupPairs(lookup, result)
    },
    staleTime: 60_000,
    retry: false,
  })

/** Подпись одного ключа справочника (значение поля, когда справочник велик). */
export const lookupLabelQuery = (lookup: LookupRef, key: string) =>
  queryOptions({
    queryKey: [
      ...dataKeys.dataset(lookup.datasetId),
      'lookup-label',
      lookup.keyField,
      lookup.labelField,
      key,
    ] as const,
    queryFn: async (): Promise<string | null> => {
      const fields = [...new Set([lookup.keyField, lookup.labelField])]
      const result = await http.post('/queries/run', {
        body: {
          spec: {
            version: 1,
            source: { kind: 'dataset', id: lookup.datasetId },
            steps: [
              { type: 'filter', where: { field: lookup.keyField, op: 'eq', value: key } },
              { type: 'select', fields },
              { type: 'limit', limit: 1, offset: 0 },
            ],
          },
        },
      })
      const [pair] = lookupPairs(lookup, result)
      return pair ? pair.label.ru : null
    },
    staleTime: 60_000,
    retry: false,
  })

export const isJobFinished = (status: JobStatus | undefined): boolean =>
  status === 'succeeded' || status === 'failed' || status === 'cancelled'

/** Задание экспорта: опрашивается, пока файл не готов. */
export const exportJobQuery = (jobId: string) =>
  queryOptions({
    queryKey: ['job', jobId] as const,
    queryFn: () => http.get('/jobs/:id', { params: { id: jobId } }),
    refetchInterval: (query) => (isJobFinished(query.state.data?.status) ? false : 1000),
  })

const FINAL_IMPORT_STATUSES = new Set<string>(IMPORT_FINAL_STATUSES)

export const isImportFinished = (status: ImportStatus | undefined): boolean =>
  status !== undefined && FINAL_IMPORT_STATUSES.has(status)

/**
 * Состояние импорта: опрашивается, пока импорт идёт сам; сводка изменений
 * (`review`) ждёт решения пользователя — опрос возобновляется после публикации.
 */
export const importQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.import(id),
    queryFn: () => http.get('/datasets/imports/:id', { params: { id } }),
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return isImportFinished(status) || status === 'review' ? false : 1000
    },
  })

/** Профиль столбца: сервер кэширует его по версии, клиент — пока версия та же. */
export const fieldProfileQuery = (datasetId: string, key: string) =>
  queryOptions({
    queryKey: dataKeys.profile(datasetId, key),
    queryFn: () =>
      http.get('/datasets/:id/fields/:key/profile', { params: { id: datasetId, key } }),
    staleTime: 60_000,
    retry: false,
  })

export const chartQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.chart(id),
    queryFn: () => http.get('/charts/:id', { params: { id } }),
  })

/** Данные графика — с политиками пользователя; нет доступа к данным — ошибка 403/404. */
export const chartDataQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.chartData(id),
    queryFn: () => http.post('/charts/:id/data', { params: { id }, body: {} }),
    retry: false,
  })

export const dashboardQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.dashboard(id),
    queryFn: () => http.get('/dashboards/:id', { params: { id } }),
  })

/** Данные всех плиток одним запросом — с фильтрами дашборда. */
export const dashboardDataQuery = (id: string, filters: Record<string, unknown>) =>
  queryOptions({
    queryKey: dataKeys.dashboardData(id, filters),
    queryFn: () => http.post('/dashboards/:id/data', { params: { id }, body: { filters } }),
    placeholderData: (previous) => previous,
  })

export const metricQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.metric(id),
    queryFn: () => http.get('/metrics/:id', { params: { id } }),
  })

/** Значение показателя — посчитано сервером с политиками пользователя (ADR-0058). */
export const metricValueQuery = (id: string, input: Partial<MetricValueInput>) =>
  queryOptions({
    queryKey: dataKeys.metricValue(id, input),
    queryFn: () => http.post('/metrics/:id/value', { params: { id }, body: input }),
    placeholderData: (previous) => previous,
    retry: false,
  })

export const dataApi = {
  /** Снять политику строк или столбцов датасета. */
  removeDatasetsPolicies: (id: string, kind: 'rows' | 'columns', policyId: string) =>
    http.delete(`/datasets/:id/policies/${kind}/:policyId` as const, {
      params: { id, policyId },
    }),
  /** Опубликовать или отменить загрузку после проверки. */
  postDatasetsImportsAction: (id: string, kind: 'publish' | 'cancel') =>
    http.post(`/datasets/imports/:id/${kind}` as const, { params: { id } }),
  patchDatasetsPoliciesRows: (
    id: string,
    policyId: string,
    body: ApiBody<'PATCH /datasets/:id/policies/rows/:policyId'>,
  ) => http.patch('/datasets/:id/policies/rows/:policyId', { params: { id, policyId }, body }),
  postDatasetsPoliciesRows: (id: string, body: ApiBody<'POST /datasets/:id/policies/rows'>) =>
    http.post('/datasets/:id/policies/rows', { params: { id }, body }),
  patchDatasetsPoliciesColumns: (
    id: string,
    policyId: string,
    body: ApiBody<'PATCH /datasets/:id/policies/columns/:policyId'>,
  ) => http.patch('/datasets/:id/policies/columns/:policyId', { params: { id, policyId }, body }),
  postDatasetsPoliciesColumns: (id: string, body: ApiBody<'POST /datasets/:id/policies/columns'>) =>
    http.post('/datasets/:id/policies/columns', { params: { id }, body }),
  postAnalyses: (body: ApiBody<'POST /analyses'>) => http.post('/analyses', { body }),
  getAnalyses: (id: string) => http.get('/analyses/:id', { params: { id } }),
  patchObjects: (id: string, body: ApiBody<'PATCH /objects/:id'>) =>
    http.patch('/objects/:id', { params: { id }, body }),
  postAnalysesRun: (id: string) => http.post('/analyses/:id/run', { params: { id } }),
  removeObjects: (id: string) => http.delete('/objects/:id', { params: { id } }),
  postObjectsRestore: (id: string) => http.post('/objects/:id/restore', { params: { id } }),
  postDatasetsAsk: (id: string, body: ApiBody<'POST /datasets/:id/ask'>) =>
    http.post('/datasets/:id/ask', { params: { id }, body }),
  patchCharts: (id: string, body: ApiBody<'PATCH /charts/:id'>) =>
    http.patch('/charts/:id', { params: { id }, body }),
  postDatasetsColumnarBuild: (id: string) =>
    http.post('/datasets/:id/columnar/build', { params: { id } }),
  postDashboards: (body: ApiBody<'POST /dashboards'>) => http.post('/dashboards', { body }),
  getDashboards: (id: string) => http.get('/dashboards/:id', { params: { id } }),
  patchDashboards: (id: string, body: ApiBody<'PATCH /dashboards/:id'>) =>
    http.patch('/dashboards/:id', { params: { id }, body }),
  postDashboardsDrill: (id: string, body: ApiBody<'POST /dashboards/:id/drill'>) =>
    http.post('/dashboards/:id/drill', { params: { id }, body }),
  postDatasetsRowsQuery: (id: string, body: ApiBody<'POST /datasets/:id/rows/query'>) =>
    http.post('/datasets/:id/rows/query', { params: { id }, body }),
  patchDatasetsRows: (
    id: string,
    rowId: string,
    body: ApiBody<'PATCH /datasets/:id/rows/:rowId'>,
  ) => http.patch('/datasets/:id/rows/:rowId', { params: { id, rowId }, body }),
  postDatasetsRows: (id: string, body: ApiBody<'POST /datasets/:id/rows'>) =>
    http.post('/datasets/:id/rows', { params: { id }, body }),
  postDatasetsVersionsRollback: (id: string, number: number) =>
    http.post('/datasets/:id/versions/:number/rollback', { params: { id, number } }),
  postDatasetsExports: (id: string, body: ApiBody<'POST /datasets/:id/exports'>) =>
    http.post('/datasets/:id/exports', { params: { id }, body }),
  getDatasetsExportsDownload: (jobId: string) =>
    http.get('/datasets/exports/:jobId/download', { params: { jobId } }),
  postDatasetsImportsAnalyze: (body: ApiBody<'POST /datasets/imports/analyze'>) =>
    http.post('/datasets/imports/analyze', { body }),
  postDatasetsImports: (body: ApiBody<'POST /datasets/imports'>) =>
    http.post('/datasets/imports', { body }),
  patchMetrics: (id: string, body: ApiBody<'PATCH /metrics/:id'>) =>
    http.patch('/metrics/:id', { params: { id }, body }),
  postMetrics: (body: ApiBody<'POST /metrics'>) => http.post('/metrics', { body }),
  getUsers: (id: string) => http.get('/users/:id', { params: { id } }),
  getDatasetsQuality: (id: string) => http.get('/datasets/:id/quality', { params: { id } }),
  putDatasetsQualityRules: (id: string, body: ApiBody<'PUT /datasets/:id/quality/rules'>) =>
    http.put('/datasets/:id/quality/rules', { params: { id }, body }),
  postDatasetsQualityRun: (id: string) =>
    http.post('/datasets/:id/quality/run', { params: { id } }),
  postDatasetsRowsDelete: (id: string, body: ApiBody<'POST /datasets/:id/rows/delete'>) =>
    http.post('/datasets/:id/rows/delete', { params: { id }, body }),
  postSqlRun: (body: ApiBody<'POST /sql/run'>) => http.post('/sql/run', { body }),
}
