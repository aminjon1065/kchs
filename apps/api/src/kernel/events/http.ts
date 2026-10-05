import { type EventDlqEntry, EventDlqList, EventDlqRetryResult } from '@kchs/contracts'
import { z } from 'zod'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { AUDIT_ACTIONS, audit } from '../audit/service.js'
import { type DlqEntry, listDlq, retryAllDlq, retryDlqEntry } from './streams.js'

const DlqParams = z.object({ id: z.string().regex(/^\d{1,20}-\d{1,20}$/) })

/** Запись очереди сбоев для экрана: событие без полезной нагрузки. */
function toContract(entry: DlqEntry): EventDlqEntry {
  const { event } = entry
  return {
    id: entry.id,
    failedAt: entry.failedAt,
    subscriber: entry.subscriber,
    error: entry.error,
    attempts: entry.attempts,
    event: {
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt,
      object: event.object
        ? { id: event.object.id, type: event.object.type, title: event.object.title ?? null }
        : null,
    },
  }
}

/**
 * Очередь сбоев шины событий для администратора (ADR-0171): событие, которое
 * подписчик не обработал после всех попыток, видно и повторяется отсюда, а не
 * теряется со строкой в журнале. Способность — как у «Здоровья системы».
 */
export function registerEventRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/admin/events/dlq',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Очередь сбоев шины событий',
    schema: {
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
      response: { 200: EventDlqList },
    },
    handler: async (request) => {
      const { items, total } = await listDlq(request.query.limit)
      return { items: items.map(toContract), total }
    },
  })

  route({
    method: 'POST',
    url: '/admin/events/dlq/:id/retry',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Повторить событие из очереди сбоев',
    schema: { params: DlqParams, response: { 200: EventDlqRetryResult } },
    handler: async (request) => {
      const { outcome, entry } = await retryDlqEntry(request.params.id)
      if (outcome === 'not_found') throw errors.notFound('Запись очереди сбоев')
      if (outcome === 'unknown_subscriber') {
        throw errors.conflict('Подписчика этого события больше нет — повторять некому', {
          subscriber: entry?.subscriber,
        })
      }
      await audit(request.ctx, {
        action: AUDIT_ACTIONS.eventsDlqRetried,
        details: {
          entry: request.params.id,
          subscriber: entry?.subscriber,
          eventId: entry?.event.id,
          type: entry?.event.type,
        },
        severity: 'notice',
      })
      return { retried: 1, skipped: 0 }
    },
  })

  route({
    method: 'POST',
    url: '/admin/events/dlq/retry-all',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Повторить всю очередь сбоев',
    schema: { response: { 200: EventDlqRetryResult } },
    handler: async (request) => {
      const result = await retryAllDlq()
      await audit(request.ctx, {
        action: AUDIT_ACTIONS.eventsDlqRetried,
        details: { all: true, ...result },
        severity: 'notice',
      })
      return result
    },
  })
}
