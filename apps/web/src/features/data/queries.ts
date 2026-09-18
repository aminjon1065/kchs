import type {
  ChartRecord,
  DashboardData,
  DashboardRecord,
  DatasetPolicies,
  DatasetRecord,
  DatasetRow,
  DatasetRowHistoryEntry,
  DatasetVersion,
  FieldOption,
  FieldProfile,
  ImportRecord,
  ImportStatus,
  JobRecord,
  JobStatus,
  MetricRecord,
  MetricValue,
  MetricValueInput,
  QueryResult,
  SqlSchema,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/** Ключи кэша модуля «Данные»: `['dataset', id, …]`, `['import', id]`. */
export const dataKeys = {
  dataset: (id: string) => ['dataset', id] as const,
  versions: (id: string) => ['dataset', id, 'versions'] as const,
  imports: (id: string) => ['dataset', id, 'imports'] as const,
  policies: (id: string) => ['dataset', id, 'policies'] as const,
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

export const datasetQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.dataset(id),
    queryFn: () => http.get<DatasetRecord>(`/datasets/${id}`),
  })

export const datasetVersionsQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.versions(id),
    queryFn: async () =>
      (await http.get<{ items: DatasetVersion[] }>(`/datasets/${id}/versions`)).items,
  })

export const datasetImportsQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.imports(id),
    queryFn: async () =>
      (await http.get<{ items: ImportRecord[] }>(`/datasets/${id}/imports`)).items,
  })

/** Датасеты и поля для подсказок SQL-лаборатории (способность `data.sql`). */
export const sqlSchemaQuery = () =>
  queryOptions({
    queryKey: ['sql', 'schema'] as const,
    queryFn: () => http.get<SqlSchema>('/sql/schema'),
    staleTime: 60_000,
  })

/** Строка по `_id` — с политиками пользователя, как в таблице. */
export const datasetRowQuery = (id: string, rowId: string) =>
  queryOptions({
    queryKey: dataKeys.row(id, rowId),
    queryFn: () => http.get<DatasetRow>(`/datasets/${id}/rows/${rowId}`),
  })

/** История строки: при ограничениях политики сервер отказывает (403) — без повторов. */
export const rowHistoryQuery = (id: string, rowId: string) =>
  queryOptions({
    queryKey: dataKeys.rowHistory(id, rowId),
    queryFn: async () =>
      (await http.get<{ items: DatasetRowHistoryEntry[] }>(`/datasets/${id}/rows/${rowId}/history`))
        .items,
    retry: false,
  })

/** Политики строк и столбцов — только для `manage+`. */
export const datasetPoliciesQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.policies(id),
    queryFn: () => http.get<DatasetPolicies>(`/datasets/${id}/policies`),
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
      const result = await http.post<QueryResult>('/queries/run', {
        spec: {
          version: 1,
          source: { kind: 'dataset', id: lookup.datasetId },
          steps: [
            { type: 'select', fields },
            { type: 'limit', limit: LOOKUP_OPTIONS_LIMIT + 1, offset: 0 },
          ],
        },
      })
      if (result.rows.length > LOOKUP_OPTIONS_LIMIT) return []
      const keyIndex = result.fields.findIndex((field) => field.name === lookup.keyField)
      const labelIndex = result.fields.findIndex((field) => field.name === lookup.labelField)
      return result.rows.flatMap((row) => {
        const key = row[keyIndex]
        const label = row[labelIndex]
        if (key === null || key === undefined || label === null || label === undefined) return []
        return [{ value: String(key), label: { ru: String(label) } }]
      })
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
    queryFn: () => http.get<JobRecord>(`/jobs/${jobId}`),
    refetchInterval: (query) => (isJobFinished(query.state.data?.status) ? false : 1000),
  })

export const isImportFinished = (status: ImportStatus | undefined): boolean =>
  status === 'succeeded' || status === 'failed'

/** Состояние импорта: опрашивается, пока импорт не завершится. */
export const importQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.import(id),
    queryFn: () => http.get<ImportRecord>(`/datasets/imports/${id}`),
    refetchInterval: (query) => (isImportFinished(query.state.data?.status) ? false : 1000),
  })

/** Профиль столбца: сервер кэширует его по версии, клиент — пока версия та же. */
export const fieldProfileQuery = (datasetId: string, key: string) =>
  queryOptions({
    queryKey: dataKeys.profile(datasetId, key),
    queryFn: () => http.get<FieldProfile>(`/datasets/${datasetId}/fields/${key}/profile`),
    staleTime: 60_000,
    retry: false,
  })

export const chartQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.chart(id),
    queryFn: () => http.get<ChartRecord>(`/charts/${id}`),
  })

/** Данные графика — с политиками пользователя; нет доступа к данным — ошибка 403/404. */
export const chartDataQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.chartData(id),
    queryFn: () => http.post<QueryResult>(`/charts/${id}/data`, {}),
    retry: false,
  })

export const dashboardQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.dashboard(id),
    queryFn: () => http.get<DashboardRecord>(`/dashboards/${id}`),
  })

/** Данные всех плиток одним запросом — с фильтрами дашборда. */
export const dashboardDataQuery = (id: string, filters: Record<string, unknown>) =>
  queryOptions({
    queryKey: dataKeys.dashboardData(id, filters),
    queryFn: () => http.post<DashboardData>(`/dashboards/${id}/data`, { filters }),
    placeholderData: (previous) => previous,
  })

export const metricQuery = (id: string) =>
  queryOptions({
    queryKey: dataKeys.metric(id),
    queryFn: () => http.get<MetricRecord>(`/metrics/${id}`),
  })

/** Значение показателя — посчитано сервером с политиками пользователя (ADR-0058). */
export const metricValueQuery = (id: string, input: Partial<MetricValueInput>) =>
  queryOptions({
    queryKey: dataKeys.metricValue(id, input),
    queryFn: () => http.post<MetricValue>(`/metrics/${id}/value`, input),
    placeholderData: (previous) => previous,
    retry: false,
  })
