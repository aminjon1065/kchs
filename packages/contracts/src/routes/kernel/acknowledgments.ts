import { defineRoutes } from '../../http/route-contract.js'
import {
  AcknowledgeInput,
  AcknowledgmentRemindInput,
  AcknowledgmentRemindResult,
  ObjectAcknowledgments,
} from '../../objects/acknowledgment.js'
import { IdParam } from '../params.js'

/**
 * Маршруты ядра «acknowledgments» (ADR-0188). Регистрация —
 * `apps/api/src/kernel/acknowledgments/`: http.ts.
 */
export const kernelAcknowledgmentsRoutes = defineRoutes({
  'GET /objects/:id/acknowledgments': { params: IdParam, response: { 200: ObjectAcknowledgments } },
  'POST /objects/:id/acknowledgments/acknowledge': {
    params: IdParam,
    body: AcknowledgeInput,
    response: { 200: ObjectAcknowledgments },
  },
  'POST /objects/:id/acknowledgments/remind': {
    params: IdParam,
    body: AcknowledgmentRemindInput,
    response: { 200: AcknowledgmentRemindResult },
  },
})
