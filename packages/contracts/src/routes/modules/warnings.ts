import { z } from 'zod'
import { defineRoutes } from '../../http/route-contract.js'
import {
  WarningCreateInput,
  WarningFromMessageInput,
  WarningList,
  WarningListQuery,
  WarningRecord,
  WarningRssParams,
  WarningSettings,
  WarningSourceList,
  WarningSourcesQuery,
  WarningSupersedeInput,
  WarningUpdateInput,
} from '../../warnings/warning.js'
import { IdParam } from '../params.js'

/**
 * Маршруты модуля «warnings» (ADR-0188, ADR-0202). Регистрация —
 * `apps/api/src/modules/warnings/`: http.ts. Ленты CAP открыты без входа и через
 * шлюз DMZ (ADR-0200): их читают сайт Комитета, агрегаторы и партнёры.
 */
export const warningsRoutes = defineRoutes({
  'GET /warnings': { query: WarningListQuery, response: { 200: WarningList } },
  'GET /warnings/settings': { response: { 200: WarningSettings } },
  'GET /warnings/sources': { query: WarningSourcesQuery, response: { 200: WarningSourceList } },
  'POST /warnings': { body: WarningCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
  'POST /warnings/from-message': {
    body: WarningFromMessageInput,
    response: { 200: z.object({ id: z.uuid() }) },
  },
  'GET /warnings/:id': { params: IdParam, response: { 200: WarningRecord } },
  'PUT /warnings/:id': {
    params: IdParam,
    body: WarningUpdateInput,
    response: { 200: WarningRecord },
  },
  'POST /warnings/:id/submit': {
    params: IdParam,
    response: { 200: z.object({ processId: z.uuid() }) },
  },
  'POST /warnings/:id/supersede': {
    params: IdParam,
    body: WarningSupersedeInput,
    response: { 200: z.object({ id: z.uuid() }) },
  },
  // Наружу (ADR-0200): индекс Atom опубликованных, сам CAP 1.2 и RSS на трёх языках
  'GET /public/cap/feed.xml': { exposure: 'public' },
  'GET /public/cap/:id.xml': { params: IdParam, exposure: 'public' },
  'GET /public/cap/rss/:lang.xml': { params: WarningRssParams, exposure: 'public' },
})
