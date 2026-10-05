import { z } from 'zod'
import {
  AlertCheckInput,
  AlertCheckResult,
  AlertCreateInput,
  AlertEnabledInput,
  AlertEventList,
  AlertEventsQuery,
  AlertList,
  AlertListQuery,
  AlertRecord,
  AlertUpdateInput,
} from '../../alerts/alert.js'
import { defineRoutes } from '../../http/route-contract.js'
import { IdParam } from '../params.js'

/**
 * Маршруты модуля «alerts» (ADR-0188). Регистрация — `apps/api/src/modules/alerts/`: http.ts.
 */
export const alertsRoutes = defineRoutes({
  'GET /alerts': { query: AlertListQuery, response: { 200: AlertList } },
  'GET /alerts/events': { query: AlertEventsQuery, response: { 200: AlertEventList } },
  'POST /alerts': { body: AlertCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
  'GET /alerts/:id': { params: IdParam, response: { 200: AlertRecord } },
  'PUT /alerts/:id': { params: IdParam, body: AlertUpdateInput, response: { 200: AlertRecord } },
  'POST /alerts/:id/enabled': {
    params: IdParam,
    body: AlertEnabledInput,
    response: { 200: AlertRecord },
  },
  'POST /alerts/:id/check': {
    params: IdParam,
    body: AlertCheckInput,
    response: { 200: AlertCheckResult },
  },
})
