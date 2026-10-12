import type {
  DeviceCreateInput,
  DeviceList,
  DeviceRecord,
  DeviceUpdateInput,
  PositionsSettings,
  RtServerPayload,
} from '@kchs/contracts'
import { type QueryClient, queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import type { ApiQuery } from '~/shared/api/route-types.js'

/** Запросы местоположения сил и средств (ADR-0203). */
export const positionKeys = {
  all: ['positions'] as const,
  list: (query: ApiQuery<'GET /positions/devices'> = {}) =>
    ['positions', 'devices', query] as const,
  device: (id: string) => ['positions', 'device', id] as const,
  track: (id: string, from: string) => ['positions', 'track', id, from] as const,
  settings: ['positions', 'settings'] as const,
}

export const devicesQuery = (query: ApiQuery<'GET /positions/devices'> = {}) =>
  queryOptions({
    queryKey: positionKeys.list(query),
    queryFn: () => http.get('/positions/devices', { query }),
    // Связь «на связи / нет связи» стареет и без новых точек — перечитать раз в минуту
    refetchInterval: 60_000,
  })

export const deviceQuery = (id: string) =>
  queryOptions({
    queryKey: positionKeys.device(id),
    queryFn: () => http.get('/positions/devices/:id', { params: { id } }),
    enabled: id.length > 0,
  })

export const deviceTrackQuery = (id: string, from: string) =>
  queryOptions({
    queryKey: positionKeys.track(id, from),
    queryFn: () =>
      http.get('/positions/devices/:id/track', { params: { id }, query: { from, limit: 500 } }),
    enabled: id.length > 0,
  })

export const positionsSettingsQuery = () =>
  queryOptions({
    queryKey: positionKeys.settings,
    queryFn: () => http.get('/admin/positions/settings'),
  })

export const positionsApi = {
  create: (input: DeviceCreateInput) => http.post('/positions/devices', { body: input }),
  update: (id: string, input: DeviceUpdateInput) =>
    http.patch('/positions/devices/:id', { params: { id }, body: input }),
  saveSettings: (input: PositionsSettings) =>
    http.put('/admin/positions/settings', { body: input }),
}

/**
 * Новая последняя точка из realtime — в кэш списка и карточки на месте, без запроса:
 * поставщик присылает точки каждые несколько секунд.
 */
export function applyPosition(
  client: QueryClient,
  payload: RtServerPayload<'device.located'>,
): void {
  const last = {
    at: payload.at,
    lat: payload.lat,
    lon: payload.lon,
    speed: payload.speed,
    heading: payload.heading,
    battery: payload.battery,
  }
  const patch = (device: DeviceRecord): DeviceRecord =>
    device.id === payload.deviceId ? { ...device, last, link: 'online' } : device
  client.setQueriesData<DeviceList>({ queryKey: ['positions', 'devices'] }, (data) =>
    data ? { ...data, items: data.items.map(patch) } : data,
  )
  client.setQueryData<DeviceRecord>(positionKeys.device(payload.deviceId), (data) =>
    data ? patch(data) : data,
  )
}
