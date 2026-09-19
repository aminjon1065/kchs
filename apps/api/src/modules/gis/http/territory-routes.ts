import {
  GeocodeQuery,
  GeocodeResponse,
  ReverseGeocodeQuery,
  ReverseGeocodeResponse,
  TerritoryFeature,
  TerritoryGeometryQuery,
  TerritoryTileQuery,
} from '@kchs/contracts'
import { z } from 'zod'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { Geocoder } from '../domain/geocoder.js'
import { TerritoryService } from '../domain/territory-service.js'
import { TerritoryTiles, tileLevels } from '../domain/territory-tiles.js'

const IdParam = z.object({ id: z.uuid() })
const TileParams = z.object({
  z: z.coerce.number().int().min(0).max(22),
  x: z.coerce.number().int().min(0),
  y: z.coerce.number().int().min(0),
})
// Карта запрашивает тайлы пачками — десятки на каждый сдвиг и зум
const TILE_RATE_LIMIT = { max: 3000, timeWindow: '1 minute' }

/**
 * Границы и геокодирование справочника территорий (P2-E04, ADR-0067). Справочник
 * открыт всем сотрудникам (ACL everyone), гостю по ссылке — нет.
 */
export function registerTerritoryRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/gis/territories/:id/geometry',
    auth: 'session',
    tags: ['gis'],
    summary: 'Граница территории GeoJSON Feature; с зумом — упрощённая до пикселя',
    schema: {
      params: IdParam,
      querystring: TerritoryGeometryQuery,
      response: { 200: TerritoryFeature },
    },
    handler: async (request) =>
      TerritoryService.feature(request.ctx, request.params.id, request.query.zoom),
  })

  route({
    method: 'GET',
    url: '/gis/territories/tiles/:z/:x/:y.pbf',
    auth: 'session',
    tags: ['gis'],
    summary: 'Векторные тайлы границ: слой MVT на уровень, у объекта id, code, level, name',
    schema: { params: TileParams, querystring: TerritoryTileQuery },
    rateLimit: TILE_RATE_LIMIT,
    handler: async (request, reply) => {
      if (request.ctx.shareLink) throw errors.forbidden()
      const { z: zoom, x, y } = request.params
      if (x >= 2 ** zoom || y >= 2 ** zoom) throw errors.validation('Тайл вне сетки своего зума')
      const tile = {
        z: zoom,
        x,
        y,
        levels: tileLevels(zoom, request.query.level),
        locale: request.query.lang ?? request.ctx.locale,
      }
      const { key, etag } = await TerritoryTiles.tag(tile)
      reply.header('etag', etag).header('cache-control', 'private, max-age=60')
      if (request.headers['if-none-match'] === etag) return reply.code(304).send()
      const data = await TerritoryTiles.render(tile, key)
      if (data.length === 0) return reply.code(204).send()
      reply.header('content-type', 'application/vnd.mapbox-vector-tile')
      return reply.send(data)
    },
  })

  route({
    method: 'GET',
    url: '/gis/geocode',
    auth: 'session',
    tags: ['gis'],
    summary: 'Геокодер: территории и населённые пункты по названию на любом языке или коду',
    schema: { querystring: GeocodeQuery, response: { 200: GeocodeResponse } },
    handler: async (request) => {
      if (request.ctx.shareLink) throw errors.forbidden()
      return { items: await Geocoder.search(request.ctx, request.query.q, request.query.limit) }
    },
  })

  route({
    method: 'GET',
    url: '/gis/geocode/reverse',
    auth: 'session',
    tags: ['gis'],
    summary: 'Обратное геокодирование: территории, содержащие точку, и ближайший населённый пункт',
    schema: { querystring: ReverseGeocodeQuery, response: { 200: ReverseGeocodeResponse } },
    handler: async (request) => {
      if (request.ctx.shareLink) throw errors.forbidden()
      return Geocoder.reverse(request.query.lon, request.query.lat)
    },
  })
}
