import type {
  ServiceLayerCheckResult,
  ServiceLayerCreateInput,
  ServiceLayerImportStarted,
  ServiceLayerList,
  ServiceLayerRecord,
  ServiceLayerUpdateInput,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/**
 * Слои-ссылки на внешние ГИС-службы (ADR-0108): реестр установки. Тайлы и
 * объекты клиент берёт через прокси API — адрес службы и ключ доступа в браузер
 * не попадают.
 */
export const serviceLayerKeys = {
  all: ['service-layers'] as const,
  list: () => ['service-layers', 'list'] as const,
}

export const serviceLayersQuery = () =>
  queryOptions({
    queryKey: serviceLayerKeys.list(),
    queryFn: () => http.get<ServiceLayerList>('/gis/service-layers'),
    staleTime: 5 * 60_000,
  })

/** Адрес тайлов слоя-ссылки для MapLibre. */
export const serviceTileUrl = (service: ServiceLayerRecord): string =>
  `/api/v1/gis/service-layers/${service.id}/tiles/{z}/{x}/{y}?v=${service.version}`

/** Адрес объектов векторной службы (WFS, ArcGIS REST). */
export const serviceFeaturesUrl = (service: ServiceLayerRecord, limit = 2000): string =>
  `/api/v1/gis/service-layers/${service.id}/features?limit=${limit}&v=${service.version}`

export const serviceLayerApi = {
  create: (input: ServiceLayerCreateInput) =>
    http.post<ServiceLayerRecord>('/gis/service-layers', input),
  update: (id: string, input: ServiceLayerUpdateInput) =>
    http.patch<ServiceLayerRecord>(`/gis/service-layers/${id}`, input),
  check: (id: string) => http.post<ServiceLayerCheckResult>(`/gis/service-layers/${id}/check`),
  remove: (id: string) => http.delete<void>(`/objects/${id}`),
  startImport: (id: string, body: { spaceId: string; bbox?: string; limit: number }) =>
    http.post<ServiceLayerImportStarted>(`/gis/service-layers/${id}/import`, body),
}
