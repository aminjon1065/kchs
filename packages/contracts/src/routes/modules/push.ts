import { z } from 'zod'
import { defineRoutes } from '../../http/route-contract.js'
import { PushStatus, PushSubscribeInput } from '../../notifications/notification.js'

/**
 * Маршруты модуля «push» (ADR-0188). Регистрация — `apps/api/src/modules/push/`: module.ts.
 */
export const pushRoutes = defineRoutes({
  'GET /me/push': { response: { 200: PushStatus } },
  'POST /me/push/subscriptions': {
    body: PushSubscribeInput,
    response: { 200: z.object({ id: z.uuid() }) },
  },
  'DELETE /me/push/subscriptions': {
    body: z.object({ endpoint: z.string().min(1).max(2000) }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
})
