import { z } from 'zod'
import {
  AssistantAskInput,
  AssistantMessage,
  AssistantThread,
  AssistantThreadQuery,
} from '../../ai/assistant.js'
import { defineRoutes } from '../../http/route-contract.js'

/**
 * Маршруты модуля «assistant» (ADR-0188). Регистрация — `apps/api/src/modules/assistant/`:
 * module.ts.
 */
export const assistantRoutes = defineRoutes({
  'GET /assistant/thread': { query: AssistantThreadQuery, response: { 200: AssistantThread } },
  'POST /assistant/ask': { body: AssistantAskInput, response: { 200: AssistantMessage } },
  'DELETE /assistant/threads/:id': {
    params: z.object({ id: z.uuid() }),
    response: { 200: z.object({ ok: z.literal(true) }) },
  },
})
