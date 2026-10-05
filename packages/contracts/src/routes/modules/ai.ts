import { TranslateInput, TranslateResult } from '../../ai/assistant.js'
import { AiStatus } from '../../ai/index.js'
import { defineRoutes } from '../../http/route-contract.js'

/**
 * Маршруты модуля «ai» (ADR-0188). Регистрация — `apps/api/src/modules/ai/`: module.ts.
 */
export const aiRoutes = defineRoutes({
  'GET /ai/status': { response: { 200: AiStatus } },
  'POST /ai/translate': { body: TranslateInput, response: { 200: TranslateResult } },
})
