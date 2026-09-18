import type {
  DatasetRecord,
  DatasetVersion,
  FieldProfile,
  ImportRecord,
  ImportStatus,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/** Ключи кэша модуля «Данные»: `['dataset', id, …]`, `['import', id]`. */
export const dataKeys = {
  dataset: (id: string) => ['dataset', id] as const,
  versions: (id: string) => ['dataset', id, 'versions'] as const,
  imports: (id: string) => ['dataset', id, 'imports'] as const,
  profile: (id: string, key: string) => ['dataset', id, 'profile', key] as const,
  import: (id: string) => ['import', id] as const,
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
