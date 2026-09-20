import {
  ServiceLayerCheckResult,
  ServiceLayerCreateInput,
  ServiceLayerFeaturesQuery,
  ServiceLayerImportInput,
  ServiceLayerImportStarted,
  ServiceLayerList,
  ServiceLayerRecord,
  ServiceLayerUpdateInput,
} from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { JobService } from '~/kernel/jobs/service.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { db } from '~/shared/db/client.js'
import { objects, serviceLayers } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { rateLimit } from '~/shared/http/rate-limit.js'
import {
  SERVICE_LAYER_IMPORT_JOB,
  type ServiceLayerImportJobData,
  ServiceLayerService,
} from './domain/service-layer-service.js'

const IdParam = z.object({ id: z.uuid() })
const TileParams = z.object({
  id: z.uuid(),
  z: z.coerce.number().int().min(0).max(24),
  x: z.coerce.number().int().min(0),
  y: z.coerce.number().int().min(0),
})
/** Тайлы службы — тот же потолок частоты, что у подложек. */
const TILES_PER_MINUTE = 6000
const MANAGE = 'gis.basemaps.manage'

/**
 * Слой-ссылка на внешнюю ГИС-службу — объект реестра `service_layer`
 * (07-gis-engine.md §5, §8; ADR-0108). Служба принадлежит установке: её видят
 * все сотрудники, ведут — управляющие подложками и внешними службами.
 */
export function registerServiceLayerObjectType(): void {
  registerObjectType({
    type: 'service_layer',
    labelKey: 'objects.types.service_layer',
    icon: 'service_layer',
    route: (id) => `/o/${id}`,
    levels: ['view', 'manage'],
    actions: {
      view: { minLevel: 'view' },
      manage: { minLevel: 'manage', capability: MANAGE },
      delete: { minLevel: 'manage', capability: MANAGE },
    },
    discussable: false,
    linkable: true,
    hasParentTree: false,
    moduleManaged: true,
    searchable: async (id) => {
      const [row] = await db()
        .select({
          title: objects.title,
          spaceId: objects.spaceId,
          parentId: objects.parentId,
          ownerId: objects.ownerId,
          updatedAt: objects.updatedAt,
          description: serviceLayers.description,
        })
        .from(serviceLayers)
        .innerJoin(objects, eq(objects.id, serviceLayers.id))
        .where(eq(serviceLayers.id, id))
        .limit(1)
      if (!row) return null
      return {
        parentId: row.parentId,
        type: 'service_layer',
        spaceId: row.spaceId,
        title: row.title,
        body: row.description ?? '',
        ownerId: row.ownerId,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: {},
      }
    },
  })
}

export function registerServiceLayerRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/gis/service-layers',
    auth: 'session',
    tags: ['gis'],
    summary: 'Слои-ссылки на внешние ГИС-службы',
    schema: { response: { 200: ServiceLayerList } },
    handler: async (request) => ({ items: await ServiceLayerService.list(request.ctx) }),
  })

  route({
    method: 'POST',
    url: '/gis/service-layers',
    auth: { capability: MANAGE },
    tags: ['gis'],
    summary: 'Добавить слой-ссылку: XYZ, WMS, WMTS, WFS или ArcGIS REST',
    schema: { body: ServiceLayerCreateInput, response: { 200: ServiceLayerRecord } },
    handler: async (request) => ServiceLayerService.create(request.ctx, request.body),
  })

  route({
    method: 'GET',
    url: '/gis/service-layers/:id',
    auth: { action: 'view' },
    tags: ['gis'],
    summary: 'Слой-ссылка: вид службы, параметры и состояние проверки',
    schema: { params: IdParam, response: { 200: ServiceLayerRecord } },
    handler: async (request) => ServiceLayerService.get(request.ctx, request.params.id),
  })

  route({
    method: 'PATCH',
    url: '/gis/service-layers/:id',
    auth: { action: 'manage' },
    tags: ['gis'],
    summary: 'Изменить слой-ссылку: адрес, параметры, ключ, масштабы',
    schema: {
      params: IdParam,
      body: ServiceLayerUpdateInput,
      response: { 200: ServiceLayerRecord },
    },
    handler: async (request) =>
      ServiceLayerService.update(request.ctx, request.params.id, request.body),
  })

  route({
    method: 'POST',
    url: '/gis/service-layers/:id/check',
    auth: { action: 'manage' },
    tags: ['gis'],
    summary: 'Проверить соединение со службой',
    schema: { params: IdParam, response: { 200: ServiceLayerCheckResult } },
    rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async (request) => {
      const result = await ServiceLayerService.check(request.ctx, request.params.id)
      return { ...result, checkedAt: new Date().toISOString() }
    },
  })

  route({
    method: 'GET',
    url: '/gis/service-layers/:id/tiles/:z/:x/:y',
    auth: { action: 'view' },
    tags: ['gis'],
    summary: 'Тайл внешней растровой службы через прокси API: ключ скрыт, кэш',
    schema: { params: TileParams },
    rateLimit: rateLimit(TILES_PER_MINUTE, '1 minute'),
    handler: async (request, reply) => {
      const { id, z, x, y } = request.params
      const tile = await ServiceLayerService.tile(id, z, x, y)
      if (!tile) return reply.code(404).send()
      return reply
        .header('content-type', tile.contentType)
        .header('cache-control', 'private, max-age=300')
        .send(tile.body)
    },
  })

  route({
    method: 'GET',
    url: '/gis/service-layers/:id/features',
    auth: { action: 'view' },
    tags: ['gis'],
    summary: 'Объекты внешней векторной службы (WFS, ArcGIS REST) как GeoJSON',
    schema: { params: IdParam, querystring: ServiceLayerFeaturesQuery },
    rateLimit: { max: 300, timeWindow: '1 minute' },
    handler: async (request, reply) => {
      const result = await ServiceLayerService.features(request.params.id, {
        ...(request.query.bbox ? { bbox: request.query.bbox } : {}),
        limit: request.query.limit,
      })
      return reply
        .header('content-type', 'application/geo+json')
        .header('cache-control', 'private, max-age=60')
        .send(result.body)
    },
  })

  route({
    method: 'POST',
    url: '/gis/service-layers/:id/import',
    auth: { action: 'manage' },
    tags: ['gis'],
    summary: 'Выгрузить объекты службы в файл GeoJSON — дальше обычный геоимпорт',
    schema: {
      params: IdParam,
      body: ServiceLayerImportInput,
      response: { 200: ServiceLayerImportStarted },
    },
    rateLimit: { max: 10, timeWindow: '1 minute' },
    handler: async (request) => {
      const [row] = await db()
        .select({ spaceId: objects.spaceId })
        .from(objects)
        .where(eq(objects.id, request.params.id))
        .limit(1)
      if (!row?.spaceId) throw errors.notFound('Слой-ссылка')
      const jobId = await JobService.enqueue(request.ctx, {
        ...SERVICE_LAYER_IMPORT_JOB,
        objectId: request.params.id,
        data: {
          serviceLayerId: request.params.id,
          ...(request.body.bbox ? { bbox: request.body.bbox } : {}),
          limit: request.body.limit,
          spaceId: row.spaceId,
        } satisfies ServiceLayerImportJobData as unknown as Record<string, unknown>,
        options: { attempts: 1 },
      })
      return { jobId }
    },
  })
}

/** Задание выгрузки объектов службы — в роли worker. */
export function registerServiceLayerBackground(): void {
  registerJobHandler({
    queue: SERVICE_LAYER_IMPORT_JOB.queue,
    name: SERVICE_LAYER_IMPORT_JOB.name,
    concurrency: 1,
    handle: async (job, helpers) => {
      const record = await JobService.get(helpers.recordId)
      const ctx = record?.initiatorId ? await buildUserCtxFor(record.initiatorId) : null
      if (!ctx) throw errors.internal('У выгрузки службы нет инициатора')
      const result = await ServiceLayerService.exportToFile(
        job.data as ServiceLayerImportJobData,
        helpers,
        ctx,
      )
      return { ...result }
    },
  })
}
