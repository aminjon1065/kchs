import { z } from 'zod'
import { defineRoutes } from '../../http/route-contract.js'
import {
  Notification,
  NotificationPreference,
  NotificationPreferences,
} from '../../notifications/notification.js'

/**
 * Маршруты ядра «notifications» (ADR-0188). Регистрация —
 * `apps/api/src/kernel/notifications/`: http.ts.
 */
export const kernelNotificationsRoutes = defineRoutes({
  'GET /notifications': {
    query: z.object({
      unreadOnly: z.coerce.boolean().default(false),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      cursor: z.string().optional(),
    }),
    response: {
      200: z.object({
        items: z.array(Notification),
        nextCursor: z.string().nullable(),
        unread: z.number().int(),
      }),
    },
  },
  'POST /notifications/read': {
    body: z.object({ ids: z.array(z.string()).optional(), all: z.boolean().default(false) }),
    response: { 200: z.object({ unread: z.number().int() }) },
  },
  'GET /me/notification-preferences': { response: { 200: NotificationPreferences } },
  'PUT /me/notification-preferences': {
    body: NotificationPreference,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
})
