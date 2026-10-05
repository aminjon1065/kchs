import { authorize } from '~/kernel/access/authorize.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { AlertCheck } from './domain/alert-check.js'
import { AlertService } from './domain/alert-service.js'

/**
 * Алерты на показатели (06-analytics-engine.md §14): список, конструктор
 * правила, «Проверить сейчас» и тестовый прогон без рассылки, история
 * срабатываний (в том числе отметки на графике показателя).
 */
export function registerAlertRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /alerts',
    auth: 'session',
    tags: ['alerts'],
    summary: 'Алерты: видимые смотрящему',
    handler: async (request) => AlertService.list(request.ctx, request.query),
  })

  route({
    route: 'GET /alerts/events',
    auth: 'session',
    tags: ['alerts'],
    summary: 'История срабатываний: по алерту или по показателю',
    handler: async (request) => AlertService.events(request.ctx, request.query),
  })

  route({
    route: 'POST /alerts',
    auth: 'session',
    tags: ['alerts'],
    summary: 'Создать алерт на показатель',
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.spaceId)
      const id = await db().transaction((tx) => AlertService.create(tx, request.ctx, request.body))
      return { id }
    },
  })

  route({
    route: 'GET /alerts/:id',
    auth: { action: 'view' },
    tags: ['alerts'],
    summary: 'Алерт: условие, разрез, расписание, каналы',
    handler: async (request) => AlertService.get(request.ctx, request.params.id),
  })

  route({
    route: 'PUT /alerts/:id',
    auth: { action: 'manage' },
    tags: ['alerts'],
    summary: 'Изменить алерт',
    handler: async (request) => {
      await db().transaction((tx) =>
        AlertService.update(tx, request.ctx, request.params.id, request.body),
      )
      return AlertService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'POST /alerts/:id/enabled',
    auth: { action: 'manage' },
    tags: ['alerts'],
    summary: 'Включить или выключить проверку',
    handler: async (request) => {
      await db().transaction((tx) =>
        AlertService.setEnabled(tx, request.ctx, request.params.id, request.body.enabled),
      )
      return AlertService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'POST /alerts/:id/check',
    auth: { action: 'manage' },
    tags: ['alerts'],
    summary: 'Проверить сейчас; тестовый прогон считает без рассылки',
    handler: async (request) => {
      const row = await AlertService.require(db(), request.params.id)
      return AlertCheck.run(row, { dryRun: request.body.dryRun })
    },
  })
}
