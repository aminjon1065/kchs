import { defineRoutes } from '../../http/route-contract.js'
import { MailPassword, MailStatus } from '../../mail/mailbox.js'

/**
 * Маршруты модуля «mail» (ADR-0188). Регистрация — `apps/api/src/modules/mail/http/`:
 * routes.ts.
 */
export const mailRoutes = defineRoutes({
  'GET /me/mail': { response: { 200: MailStatus } },
  'POST /me/mail/password': { response: { 200: MailPassword } },
  'DELETE /me/mail/password': { response: { 200: MailStatus } },
})
