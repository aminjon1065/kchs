import { z } from 'zod'
import { defineRoutes } from '../../http/route-contract.js'
import {
  InboxActionInput,
  InboxBulkInput,
  InboxBulkResult,
  InboxCounts,
  InboxItem,
  InboxQuery,
} from '../../notifications/inbox.js'

/**
 * Маршруты ядра «inbox» (ADR-0188). Регистрация — `apps/api/src/kernel/inbox/`: http.ts.
 */
export const kernelInboxRoutes = defineRoutes({
  'GET /inbox': {
    query: InboxQuery,
    response: {
      200: z.object({ items: z.array(InboxItem), nextCursor: z.string().nullable() }),
    },
  },
  'GET /inbox/counts': { response: { 200: InboxCounts } },
  'POST /inbox/:id/act': {
    params: z.object({ id: z.uuid() }),
    body: InboxActionInput,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'POST /inbox/bulk': { body: InboxBulkInput, response: { 200: InboxBulkResult } },
  'POST /inbox/:id/snooze': {
    params: z.object({ id: z.uuid() }),
    body: z.object({ until: z.iso.datetime({ offset: true }) }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
})
