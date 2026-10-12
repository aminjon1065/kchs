import type { EventEnvelope, EventPayload } from '@kchs/contracts'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { emitToRoom } from '~/kernel/realtime/gateway.js'

/**
 * Живые позиции (ADR-0203): новая последняя точка устройства — в комнату его
 * карточки `object:{deviceId}` (там же экран «Устройства слежения» держит свои
 * строки) и в комнату датасета проекции — слоя «Техника и группы» карты
 * обстановки. Права проверены при подписке на комнату: видит тот, кто видит
 * устройство или датасет.
 */
export function registerPositionSubscribers(): void {
  registerSubscriber({
    name: 'positions-realtime',
    types: ['device.located'],
    handle: async (event: EventEnvelope) => {
      const deviceId = event.object?.id
      if (!deviceId) return
      const payload = event.payload as EventPayload<'device.located'>
      const message = {
        deviceId,
        at: payload.at,
        lat: payload.lat,
        lon: payload.lon,
        speed: payload.speed,
        heading: payload.heading,
        battery: payload.battery,
      }
      emitToRoom(`object:${deviceId}`, 'device.located', message)
      if (payload.datasetId) emitToRoom(`object:${payload.datasetId}`, 'device.located', message)
    },
  })
}
