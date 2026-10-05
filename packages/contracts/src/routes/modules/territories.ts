import { z } from 'zod'
import {
  GeocodeQuery,
  GeocodeResponse,
  ReverseGeocodeQuery,
  ReverseGeocodeResponse,
} from '../../gis/geocode.js'
import {
  TerritoryDetail,
  TerritoryFeature,
  TerritoryGeometryQuery,
  TerritoryList,
  TerritoryTileQuery,
} from '../../gis/territory.js'
import { defineRoutes } from '../../http/route-contract.js'
import { IdParam } from '../params.js'

const TileParams = z.object({
  z: z.coerce.number().int().min(0).max(22),
  x: z.coerce.number().int().min(0),
  y: z.coerce.number().int().min(0),
})

/**
 * Маршруты модуля «territories» (ADR-0188). Регистрация —
 * `apps/api/src/modules/territories/http/`: territory-routes.ts.
 */
export const territoriesRoutes = defineRoutes({
  'GET /territories': { response: { 200: TerritoryList } },
  'GET /territories/:id': { params: IdParam, response: { 200: TerritoryDetail } },
  'GET /gis/territories/:id/geometry': {
    params: IdParam,
    query: TerritoryGeometryQuery,
    response: { 200: TerritoryFeature },
  },
  'GET /gis/territories/tiles/:z/:x/:y.pbf': { params: TileParams, query: TerritoryTileQuery },
  'GET /gis/geocode': { query: GeocodeQuery, response: { 200: GeocodeResponse } },
  'GET /gis/geocode/reverse': {
    query: ReverseGeocodeQuery,
    response: { 200: ReverseGeocodeResponse },
  },
})
