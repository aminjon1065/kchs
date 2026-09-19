import {
  AcknowledgeInput,
  AcknowledgmentRemindInput,
  AcknowledgmentRemindResult,
  ObjectAcknowledgments,
} from '@kchs/contracts'
import { z } from 'zod'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { authorize } from '../access/authorize.js'
import { Acknowledgments } from './service.js'

const IdParam = z.object({ id: z.uuid() })

/**
 * Ознакомление с объектом (08-documents.md §10, ADR-0084): список «кто
 * ознакомился», отметка «Ознакомлен» и напоминание. Запрос создаёт модуль типа
 * (документы — `POST /documents/{id}/acknowledgments`): он же выдаёт права.
 */
export function registerAcknowledgmentRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/objects/:id/acknowledgments',
    auth: 'session',
    tags: ['acknowledgments'],
    summary: 'Ознакомление с объектом: кто ознакомился, кто нет, запросы',
    schema: { params: IdParam, response: { 200: ObjectAcknowledgments } },
    handler: async (request) => Acknowledgments.list(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/objects/:id/acknowledgments/acknowledge',
    auth: 'session',
    tags: ['acknowledgments'],
    summary: 'Отметить «Ознакомлен» (с кодом второго фактора, если его требует запрос)',
    schema: { params: IdParam, body: AcknowledgeInput, response: { 200: ObjectAcknowledgments } },
    handler: async (request) => {
      await db().transaction((tx) =>
        Acknowledgments.acknowledge(tx, request.ctx, request.params.id, request.body),
      )
      return Acknowledgments.list(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/objects/:id/acknowledgments/remind',
    auth: 'session',
    tags: ['acknowledgments'],
    summary: 'Напомнить не ознакомившимся (не чаще раза в час одному сотруднику)',
    schema: {
      params: IdParam,
      body: AcknowledgmentRemindInput,
      response: { 200: AcknowledgmentRemindResult },
    },
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
