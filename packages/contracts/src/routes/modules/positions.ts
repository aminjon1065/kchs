import { z } from 'zod'
import { defineRoutes } from '../../http/route-contract.js'
import {
  DeviceCreateInput,
  DeviceList,
  DeviceListQuery,
  DeviceRecord,
  DeviceTrack,
  DeviceTrackQuery,
  DeviceUpdateInput,
  PositionBatchInput,
  PositionBatchResult,
  PositionsSettings,
} from '../../positions/position.js'
import { IdParam } from '../params.js'

/**
 * Маршруты модуля «positions» (ADR-0203). Регистрация — `apps/api/src/modules/positions/`:
 * http/routes.ts. `POST /public/positions` — опубликованный канал приёма координат
 * (концепт-нота, приложение C, канал 10): тег `positions`, область `write:positions`;
 * префикс `/public/` — то, что пропускает наружу шлюз публичного контура.
 */
export const positionsRoutes = defineRoutes({
  'POST /public/positions': { body: PositionBatchInput, response: { 200: PositionBatchResult } },
  'GET /positions/devices': { query: DeviceListQuery, response: { 200: DeviceList } },
  'POST /positions/devices': {
    body: DeviceCreateInput,
    response: { 200: z.object({ id: z.uuid() }) },
  },
  'GET /positions/devices/:id': { params: IdParam, response: { 200: DeviceRecord } },
  'PATCH /positions/devices/:id': {
    params: IdParam,
    body: DeviceUpdateInput,
    response: { 200: DeviceRecord },
  },
  'GET /positions/devices/:id/track': {
    params: IdParam,
    query: DeviceTrackQuery,
    response: { 200: DeviceTrack },
  },
  'GET /admin/positions/settings': { response: { 200: PositionsSettings } },
  'PUT /admin/positions/settings': {
    body: PositionsSettings,
    response: { 200: PositionsSettings },
  },
})
