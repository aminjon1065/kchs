import { z } from 'zod'
import { defineRoutes } from '../../http/route-contract.js'
import { TelegramLinkStart, TelegramStatus } from '../../integrations/telegram.js'

/**
 * Маршруты модуля «telegram» (ADR-0188). Регистрация — `apps/api/src/modules/telegram/`:
 * module.ts.
 */
export const telegramRoutes = defineRoutes({
  'GET /me/telegram': { response: { 200: TelegramStatus } },
  'POST /me/telegram/link': { response: { 200: TelegramLinkStart } },
  'DELETE /me/telegram': { response: { 200: z.object({ ok: z.boolean() }) } },
})
