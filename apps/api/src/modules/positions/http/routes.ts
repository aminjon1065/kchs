import { authorize } from '~/kernel/access/authorize.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { DeviceService } from '../domain/device-service.js'
import { PositionIngest } from '../domain/ingest.js'
import { PositionsSettingsService } from '../domain/settings.js'

/** Запросов приёма в минуту на отправителя: пакет до 500 точек раз в секунду с запасом. */
const INGEST_PER_MINUTE = 120

/**
 * Местоположение сил и средств (ADR-0203): приём координат, реестр устройств,
 * трек и настройки. Тег `positions` — область токена `read|write:positions`
 * (ADR-0097); `POST /public/positions` — канал, который шлюз публичного контура
 * пропускает наружу по префиксу `/public/`.
 */
export function registerPositionRoutes(route: RouteRegistrar): void {
  route({
    route: 'POST /public/positions',
    auth: 'session',
    tags: ['positions'],
    summary: 'Принять пакет координат устройств слежения',
    description:
      'Поставщик мониторинга — токеном с областью write:positions; сотрудник с телефона группы — ' +
      'в своей сессии. Устройство — внешний номер, заведённый в реестре; повтор точки не пишется.',
    rateLimit: { max: INGEST_PER_MINUTE, timeWindow: '1 minute' },
    handler: async (request) =>
      PositionIngest.accept(request.ctx, request.body, request.ctx.apiToken ? 'token' : 'session'),
  })

  route({
    route: 'GET /positions/devices',
    auth: 'session',
    tags: ['positions'],
    summary: 'Устройства слежения, видимые смотрящему, с последней точкой',
    handler: async (request) => DeviceService.list(request.ctx, request.query),
  })

  route({
    route: 'POST /positions/devices',
    auth: 'session',
    tags: ['positions'],
    summary: 'Завести устройство слежения',
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.spaceId)
      const id = await db().transaction((tx) => DeviceService.create(tx, request.ctx, request.body))
      return { id }
    },
  })

  route({
    route: 'GET /positions/devices/:id',
    auth: { action: 'view' },
    tags: ['positions'],
    summary: 'Карточка устройства слежения',
    handler: async (request) => DeviceService.get(request.ctx, request.params.id),
  })

  route({
    route: 'PATCH /positions/devices/:id',
    auth: { action: 'edit' },
    tags: ['positions'],
    summary: 'Изменить карточку устройства: имя, номер, единица сил, кто передаёт, включено',
    handler: async (request) => {
      await db().transaction((tx) =>
        DeviceService.update(tx, request.ctx, request.params.id, request.body),
      )
      return DeviceService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'GET /positions/devices/:id/track',
    auth: { action: 'view' },
    tags: ['positions'],
    summary: 'Трек устройства за период',
    handler: async (request) => DeviceService.track(request.ctx, request.params.id, request.query),
  })

  route({
    route: 'GET /admin/positions/settings',
    auth: { capability: 'admin.system' },
    tags: ['positions'],
    summary: 'Настройки местоположения: срок хранения, датасет проекции, порог «нет связи»',
    handler: async () => PositionsSettingsService.current(),
  })

  route({
    route: 'PUT /admin/positions/settings',
    auth: { capability: 'admin.system' },
    tags: ['positions'],
    summary: 'Изменить настройки местоположения',
    handler: async (request) =>
      db().transaction((tx) => PositionsSettingsService.update(tx, request.ctx, request.body)),
  })
}
