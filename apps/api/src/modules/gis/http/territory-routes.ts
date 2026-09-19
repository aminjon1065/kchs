import { promisify } from 'node:util'
import { gunzip as gunzipCallback } from 'node:zlib'
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
import { rateLimit } from '~/shared/http/rate-limit.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { Geocoder } from '../domain/geocoder.js'
import { TerritoryService } from '../domain/territory-service.js'
import { TerritoryTiles, tileLevels } from '../domain/territory-tiles.js'

const gunzip = promisify(gunzipCallback)

const IdParam = z.object({ id: z.uuid() })
const TileParams = z.object({
  z: z.coerce.number().int().min(0).max(22),
  x: z.coerce.number().int().min(0),
  y: z.coerce.number().int().min(0),
})
// Карта запрашивает тайлы пачками — десятки на каждый сдвиг и зум: свой счётчик частоты
const TILES_PER_MINUTE = 12_000

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
    rateLimit: rateLimit(TILES_PER_MINUTE, '1 minute'),
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
      const body = await TerritoryTiles.render(tile, key)
      if (body.length === 0) return reply.code(204).send()
      reply.header('content-type', 'application/vnd.mapbox-vector-tile')
      // Тайл в кэше сжат: браузеры принимают gzip, остальным — как есть
      if (/\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''))) {
        reply.header('content-encoding', 'gzip').header('vary', 'accept-encoding')
        return reply.send(body)
      }
      return reply.send(await gunzip(body))
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
