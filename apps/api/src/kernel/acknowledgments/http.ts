import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { authorize } from '../access/authorize.js'
import { Acknowledgments } from './service.js'

/**
 * Ознакомление с объектом (08-documents.md §10, ADR-0084): список «кто
 * ознакомился», отметка «Ознакомлен» и напоминание. Запрос создаёт модуль типа
 * (документы — `POST /documents/{id}/acknowledgments`): он же выдаёт права.
 */
export function registerAcknowledgmentRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /objects/:id/acknowledgments',
    auth: { delegated: 'Acknowledgments.list', objectType: 'any' },
    tags: ['acknowledgments'],
    summary: 'Ознакомление с объектом: кто ознакомился, кто нет, запросы',
    handler: async (request) => Acknowledgments.list(request.ctx, request.params.id),
  })

  route({
    route: 'POST /objects/:id/acknowledgments/acknowledge',
    auth: { delegated: 'Acknowledgments.acknowledge', objectType: 'any' },
    tags: ['acknowledgments'],
    summary: 'Отметить «Ознакомлен» (с кодом второго фактора, если его требует запрос)',
    handler: async (request) => {
      await db().transaction((tx) =>
        Acknowledgments.acknowledge(tx, request.ctx, request.params.id, request.body),
      )
      return Acknowledgments.list(request.ctx, request.params.id)
    },
  })

  route({
    route: 'POST /objects/:id/acknowledgments/remind',
    auth: { delegated: 'authorize(request_acknowledgment)', objectType: 'any' },
    tags: ['acknowledgments'],
    summary: 'Напомнить не ознакомившимся (не чаще раза в час одному сотруднику)',
    handler: async (request) => {
      await authorize(request.ctx, 'request_acknowledgment', request.params.id)
      const reminded = await db().transaction((tx) =>
        Acknowledgments.remind(tx, request.ctx, request.params.id, {
          userIds: request.body.userIds,
        }),
      )
      return { reminded: reminded.length }
    },
  })
}
