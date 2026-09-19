import { promisify } from 'node:util'
import { gunzip as gunzipCallback } from 'node:zlib'
import {
  LayerCreateInput,
  LayerFeature,
  LayerFeatureCollection,
  LayerFeaturesQuery,
  LayerList,
  LayerRecord,
  LayerTileQuery,
  LayerUpdateInput,
  MapCreateInput,
  MapRecord,
  MapUpdateInput,
  TerritoryDetail,
  TerritoryList,
} from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { registerSystemDataset } from '~/kernel/system-datasets.js'
import { db } from '~/shared/db/client.js'
import { objects, territories } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { rateLimit } from '~/shared/http/rate-limit.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { FeatureService } from './domain/feature-service.js'
import { LayerService } from './domain/layer-service.js'
import { MapService } from './domain/map-service.js'
import { TERRITORIES_SYSTEM_DATASET } from './domain/system-dataset.js'
import { TerritoryService } from './domain/territory-service.js'
import { TileService } from './domain/tile-service.js'
import { registerTerritoryRoutes } from './http/territory-routes.js'

const gunzip = promisify(gunzipCallback)

const IdParam = z.object({ id: z.uuid() })
const TileParams = z.object({
  id: z.uuid(),
  z: z.coerce.number().int().min(0).max(24),
  x: z.coerce.number().int().min(0),
  y: z.coerce.number().int().min(0),
})
const FeatureParams = z.object({ id: z.uuid(), rowId: z.string().regex(/^\d{1,18}$/) })
const DatasetLayersQuery = z.object({ datasetId: z.uuid() })
/**
 * Карта при движении запрашивает десятки тайлов в секунду (экран — 12–20 тайлов,
 * быстрый пролёт — несколько экранов в секунду): свой счётчик частоты.
 */
const TILES_PER_MINUTE = 12_000
/** Тайлы в браузере: адрес содержит версию данных и слоя, ETag — политики смотрящего. */
const TILE_CACHE_CONTROL = 'private, max-age=300'

/** Поиск по картам и слоям: название и подзаголовок объекта. */
async function titleSearchable(id: string, type: 'layer' | 'map') {
  const [row] = await db()
    .select({
      title: objects.title,
      subtitle: objects.subtitle,
      spaceId: objects.spaceId,
      parentId: objects.parentId,
      ownerId: objects.ownerId,
      updatedAt: objects.updatedAt,
    })
    .from(objects)
    .where(eq(objects.id, id))
    .limit(1)
  if (!row) return null
  return {
    parentId: row.parentId,
    type,
    spaceId: row.spaceId,
    title: row.title,
    body: row.subtitle ?? '',
    ownerId: row.ownerId,
    updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
    meta: {},
  }
}

/** Типы объектов модуля GIS: территории (07-gis-engine.md §11), слои и карты (ADR-0064). */
export function registerGisObjectTypes(): void {
  // Слой и карта: права на объект не открывают данные — тайлы и объекты
  // читаются с политиками смотрящего (03-access-model.md)
  for (const type of ['layer', 'map'] as const) {
    registerObjectType({
      type,
      labelKey: `objects.types.${type}`,
      icon: type,
      route: (id) => `/o/${id}`,
      levels: ['view', 'comment', 'edit', 'manage', 'owner'],
      actions: {
        view: { minLevel: 'view' },
        comment: { minLevel: 'comment' },
        edit: { minLevel: 'edit' },
        manage: { minLevel: 'manage' },
        share: { minLevel: 'manage' },
        delete: { minLevel: 'manage' },
      },
      discussable: true,
      linkable: true,
      hasParentTree: true,
      searchable: (id) => titleSearchable(id, type),
    })
  }

  registerObjectType({
    type: 'territory',
    labelKey: 'objects.types.territory',
    icon: 'territory',
    route: (id) => `/o/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      comment: { minLevel: 'comment' },
      manage: { minLevel: 'manage' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: false,
    // Код и названия на всех языках: «Хатлон», «Khatlon», «TJ-KT» находят одну единицу
    searchable: async (id) => {
      const [row] = await db()
        .select({
          title: objects.title,
          updatedAt: objects.updatedAt,
          code: territories.code,
          name: territories.name,
          level: territories.level,
        })
        .from(territories)
        .innerJoin(objects, eq(objects.id, territories.id))
        .where(eq(territories.id, id))
        .limit(1)
      if (!row) return null
      return {
        parentId: null,
        type: 'territory',
        spaceId: null,
        title: row.title,
        body: [row.code, row.name.ru, row.name.tg ?? '', row.name.en ?? ''].join('\n'),
        ownerId: null,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: { code: row.code, level: row.level },
      }
    },
  })

  // Справочник с границами — источник запросов и цель шага spatial (ADR-0069)
  registerSystemDataset(TERRITORIES_SYSTEM_DATASET)
}

export function registerGisRoutes(route: RouteRegistrar): void {
  registerTerritoryRoutes(route)
  route({
    method: 'GET',
    url: '/territories',
    auth: 'session',
    tags: ['gis'],
    summary: 'Справочник территорий: все единицы для дерева, пикеров и подписей',
    schema: { response: { 200: TerritoryList } },
    handler: async (request) => {
      // Справочник открыт сотрудникам (ACL everyone), гостю по ссылке — нет
      if (request.ctx.shareLink) throw errors.forbidden()
      return { items: await TerritoryService.list() }
    },
  })

  route({
    method: 'GET',
    url: '/territories/:id',
    auth: 'session',
    tags: ['gis'],
    summary: 'Карточка территории: путь от корня, дочерние единицы, атрибуты',
    schema: { params: IdParam, response: { 200: TerritoryDetail } },
    handler: async (request) => TerritoryService.get(request.ctx, request.params.id),
  })

  // ── Слои (ADR-0064) ─────────────────────────────────────────────────────────

  route({
    method: 'POST',
    url: '/gis/layers',
    auth: 'session',
    tags: ['gis'],
    summary: 'Создать слой — представление датасета на карте',
    schema: { body: LayerCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await db().transaction((tx) => LayerService.create(tx, request.ctx, request.body))
      return { id }
    },
  })

  route({
    method: 'GET',
    url: '/gis/layers',
    auth: 'session',
    tags: ['gis'],
    summary: 'Слои датасета, видимые пользователю, — «Показать на карте»',
    schema: { querystring: DatasetLayersQuery, response: { 200: LayerList } },
    handler: async (request) => {
      await authorize(request.ctx, 'view', request.query.datasetId)
      return { items: await LayerService.forDataset(request.ctx, request.query.datasetId) }
    },
  })

  route({
    method: 'GET',
    url: '/gis/layers/:id',
    auth: { action: 'view' },
    tags: ['gis'],
    summary: 'Слой: стиль, поля тайла, экстент и версия данных',
    schema: { params: IdParam, response: { 200: LayerRecord } },
    handler: async (request) => LayerService.get(request.ctx, request.params.id),
  })

  route({
    method: 'PATCH',
    url: '/gis/layers/:id',
    auth: { action: 'edit' },
    tags: ['gis'],
    summary: 'Изменить слой: название, стиль, поля тайла, правка и модерация',
    schema: { params: IdParam, body: LayerUpdateInput, response: { 200: LayerRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        LayerService.update(tx, request.ctx, request.params.id, request.body),
      )
      return LayerService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'GET',
    url: '/gis/layers/:id/tiles/:z/:x/:y.pbf',
    auth: { action: 'view' },
    tags: ['gis'],
    summary: 'Векторный тайл слоя (MVT) — с политиками строк и столбцов пользователя',
    description:
      'Пустой тайл и тайл, не уложившийся в тайм-аут, — 204; во втором случае заголовок `x-kchs-tile: timeout`.',
    schema: { params: TileParams, querystring: LayerTileQuery },
    rateLimit: rateLimit(TILES_PER_MINUTE, '1 minute'),
    handler: async (request, reply) => {
      const { id, z: zoom, x, y } = request.params
      const tile = await TileService.tile(request.ctx, id, zoom, x, y, request.query)
      reply.header('cache-control', TILE_CACHE_CONTROL)
      reply.header('etag', tile.etag)
      reply.header(
        'server-timing',
        tile.sqlMs === null
          ? `cache;desc=${tile.cached ? 'hit' : 'none'}`
          : `sql;dur=${tile.sqlMs.toFixed(1)}`,
      )
      if (tile.timedOut) reply.header('x-kchs-tile', 'timeout')
      if (request.headers['if-none-match'] === tile.etag && !tile.timedOut) {
        return reply.code(304).send()
      }
      if (!tile.body) return reply.code(204).send()
      reply.type('application/vnd.mapbox-vector-tile')
      // В кэше тайл хранится сжатым: браузеры принимают gzip, остальным — как есть
      if (/\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''))) {
        reply.header('content-encoding', 'gzip')
        reply.header('vary', 'accept-encoding')
        return reply.send(tile.body)
      }
      return reply.send(await gunzip(tile.body))
    },
  })

  route({
    method: 'GET',
    url: '/gis/layers/:id/features',
    auth: { action: 'view' },
    tags: ['gis'],
    summary: 'Объекты слоя GeoJSON в охвате — мелкие слои и правка (до 5 000)',
    schema: {
      params: IdParam,
      querystring: LayerFeaturesQuery,
      response: { 200: LayerFeatureCollection },
    },
    handler: async (request) =>
      FeatureService.features(request.ctx, request.params.id, request.query),
  })

  route({
    method: 'GET',
    url: '/gis/layers/:id/features/:rowId',
    auth: { action: 'view' },
    tags: ['gis'],
    summary: 'Карточка объекта слоя: видимые поля строки и геометрия',
    schema: { params: FeatureParams, response: { 200: LayerFeature } },
    handler: async (request) =>
      FeatureService.feature(request.ctx, request.params.id, request.params.rowId),
  })

  // ── Карты (ADR-0064) ────────────────────────────────────────────────────────

  route({
    method: 'POST',
    url: '/gis/maps',
    auth: 'session',
    tags: ['gis'],
    summary: 'Создать карту — композицию слоёв',
    schema: { body: MapCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await db().transaction((tx) => MapService.create(tx, request.ctx, request.body))
      return { id }
    },
  })

  route({
    method: 'GET',
    url: '/gis/maps/:id',
    auth: { action: 'view' },
    tags: ['gis'],
    summary: 'Карта: базовая карта, слои, вид, закладки',
    schema: { params: IdParam, response: { 200: MapRecord } },
    handler: async (request) => MapService.get(request.ctx, request.params.id),
  })

  route({
    method: 'PATCH',
    url: '/gis/maps/:id',
    auth: { action: 'edit' },
    tags: ['gis'],
    summary: 'Изменить карту: название, слои, вид, закладки',
    schema: { params: IdParam, body: MapUpdateInput, response: { 200: MapRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        MapService.update(tx, request.ctx, request.params.id, request.body),
      )
      return MapService.get(request.ctx, request.params.id)
    },
  })
}
