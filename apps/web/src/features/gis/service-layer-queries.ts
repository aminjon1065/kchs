import type {
  ServiceLayerCreateInput,
  ServiceLayerRecord,
  ServiceLayerUpdateInput,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import { apiUrl, tileUrl } from '~/shared/api/link.js'

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
    queryFn: () => http.get('/gis/service-layers'),
    staleTime: 5 * 60_000,
  })

/** Адрес тайлов слоя-ссылки для MapLibre. */
export const serviceTileUrl = (service: ServiceLayerRecord): string =>
  tileUrl('/gis/service-layers/:id/tiles/:z/:x/:y', {
    params: { id: service.id },
    query: { v: service.version },
  })

/** Адрес объектов векторной службы (WFS, ArcGIS REST). */
export const serviceFeaturesUrl = (service: ServiceLayerRecord, limit = 2000): string =>
  apiUrl('/gis/service-layers/:id/features', {
    params: { id: service.id },
    query: { limit, v: service.version },
  })

export const serviceLayerApi = {
  create: (input: ServiceLayerCreateInput) => http.post('/gis/service-layers', { body: input }),
  update: (id: string, input: ServiceLayerUpdateInput) =>
    http.patch('/gis/service-layers/:id', { params: { id }, body: input }),
  check: (id: string) => http.post('/gis/service-layers/:id/check', { params: { id } }),
  remove: (id: string) => http.delete('/objects/:id', { params: { id } }),
  startImport: (id: string, body: { spaceId: string; bbox?: string; limit: number }) =>
    http.post('/gis/service-layers/:id/import', { params: { id }, body }),
}
