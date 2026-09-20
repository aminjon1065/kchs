import {
  AlertCheckInput,
  AlertCheckResult,
  AlertCreateInput,
  AlertEnabledInput,
  AlertEventList,
  AlertEventsQuery,
  AlertList,
  AlertListQuery,
  AlertRecord,
  AlertUpdateInput,
} from '@kchs/contracts'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { AlertCheck } from './domain/alert-check.js'
import { AlertService } from './domain/alert-service.js'

const IdParam = z.object({ id: z.uuid() })

/**
 * Алерты на показатели (06-analytics-engine.md §14): список, конструктор
 * правила, «Проверить сейчас» и тестовый прогон без рассылки, история
 * срабатываний (в том числе отметки на графике показателя).
 */
export function registerAlertRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/alerts',
    auth: 'session',
    tags: ['alerts'],
    summary: 'Алерты: видимые смотрящему',
    schema: { querystring: AlertListQuery, response: { 200: AlertList } },
    handler: async (request) => AlertService.list(request.ctx, request.query),
  })

  route({
    method: 'GET',
    url: '/alerts/events',
    auth: 'session',
    tags: ['alerts'],
    summary: 'История срабатываний: по алерту или по показателю',
    schema: { querystring: AlertEventsQuery, response: { 200: AlertEventList } },
    handler: async (request) => AlertService.events(request.ctx, request.query),
  })

  route({
    method: 'POST',
    url: '/alerts',
    auth: 'session',
    tags: ['alerts'],
    summary: 'Создать алерт на показатель',
    schema: { body: AlertCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.spaceId)
      const id = await db().transaction((tx) => AlertService.create(tx, request.ctx, request.body))
      return { id }
    },
  })

  route({
    method: 'GET',
    url: '/alerts/:id',
    auth: { action: 'view' },
    tags: ['alerts'],
    summary: 'Алерт: условие, разрез, расписание, каналы',
    schema: { params: IdParam, response: { 200: AlertRecord } },
    handler: async (request) => AlertService.get(request.ctx, request.params.id),
  })

  route({
    method: 'PUT',
    url: '/alerts/:id',
    auth: { action: 'manage' },
    tags: ['alerts'],
    summary: 'Изменить алерт',
    schema: { params: IdParam, body: AlertUpdateInput, response: { 200: AlertRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        AlertService.update(tx, request.ctx, request.params.id, request.body),
      )
      return AlertService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/alerts/:id/enabled',
    auth: { action: 'manage' },
    tags: ['alerts'],
    summary: 'Включить или выключить проверку',
    schema: { params: IdParam, body: AlertEnabledInput, response: { 200: AlertRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        AlertService.setEnabled(tx, request.ctx, request.params.id, request.body.enabled),
      )
      return AlertService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/alerts/:id/check',
    auth: { action: 'manage' },
    tags: ['alerts'],
    summary: 'Проверить сейчас; тестовый прогон считает без рассылки',
    schema: { params: IdParam, body: AlertCheckInput, response: { 200: AlertCheckResult } },
    handler: async (request) => {
      const row = await AlertService.require(db(), request.params.id)
      return AlertCheck.run(row, { dryRun: request.body.dryRun })
    },
  })
}
