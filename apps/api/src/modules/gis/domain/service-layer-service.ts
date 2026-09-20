import { createHash } from 'node:crypto'
import {
  RASTER_SERVICE_KINDS,
  RasterUrlTemplate,
  SERVICE_LAYER_CACHE_TTL,
  SERVICE_LAYER_FEATURES_LIMIT,
  type ServiceLayerCreateInput,
  type ServiceLayerImportResult,
  ServiceLayerKind,
  ServiceLayerParams,
  type ServiceLayerRecord,
  type ServiceLayerUpdateInput,
} from '@kchs/contracts'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { grantAccess } from '~/kernel/access/acl-service.js'
import { authorize, hasCapability, requireCapability } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { buckets, putObject, storageKey } from '~/kernel/storage/s3.js'
import { registerStoredFile } from '~/modules/files/public.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { decryptSecret, encryptSecret } from '~/shared/crypto/secrets.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, serviceLayers } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { redis } from '~/shared/redis/index.js'
import { fetchExternal } from './raster-fetch.js'
import { serviceTileUrl } from './service-url.js'

/**
 * Слой-ссылка на внешнюю ГИС-службу (07-gis-engine.md §5, §8; ADR-0108).
 * Растровые виды идут тайлами через прокси с кэшем в Redis, векторные (WFS,
 * ArcGIS REST) отдают объекты GeoJSON и разово выгружаются в файл, который
 * дальше читает обычный геоимпорт движка. Ключ доступа хранится шифром и в
 * браузер не попадает.
 */
const MANAGE = 'gis.basemaps.manage'
const FEATURES_MAX_BYTES = 32 * 1024 * 1024
const IMPORT_PAGE = 1000

const isRaster = (kind: string) => (RASTER_SERVICE_KINDS as readonly string[]).includes(kind)

const columns = {
  id: serviceLayers.id,
  kind: serviceLayers.kind,
  url: serviceLayers.url,
  params: serviceLayers.params,
  description: serviceLayers.description,
  attribution: serviceLayers.attribution,
  minZoom: serviceLayers.minZoom,
  maxZoom: serviceLayers.maxZoom,
  opacity: serviceLayers.opacity,
  tileSize: serviceLayers.tileSize,
  status: serviceLayers.status,
  statusMessage: serviceLayers.statusMessage,
  lastCheckAt: serviceLayers.lastCheckAt,
  secretEnc: serviceLayers.secretEnc,
  createdAt: serviceLayers.createdAt,
  updatedAt: serviceLayers.updatedAt,
  name: objects.title,
  version: objects.version,
}

async function loadRow(id: string, executor: Executor = db()) {
  const [row] = await executor
    .select(columns)
    .from(serviceLayers)
    .innerJoin(objects, eq(objects.id, serviceLayers.id))
    .where(and(eq(serviceLayers.id, id), isNull(objects.deletedAt)))
    .limit(1)
  return row ?? null
}

type LoadedRow = NonNullable<Awaited<ReturnType<typeof loadRow>>>

const paramsOf = (row: LoadedRow) => ServiceLayerParams.parse(row.params)

/** Метка адреса и параметров: смена настроек начинает кэш заново. */
const tag = (row: LoadedRow) =>
  createHash('sha256')
    .update(`${row.url}|${JSON.stringify(row.params)}|${row.tileSize}`)
    .digest('hex')
    .slice(0, 12)

function toRecord(row: LoadedRow, manager: boolean): ServiceLayerRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: ServiceLayerKind.parse(row.kind),
    url: manager ? row.url : null,
    params: paramsOf(row),
    hasKey: row.secretEnc !== null,
    attribution: row.attribution,
    minZoom: row.minZoom,
    maxZoom: row.maxZoom,
    opacity: row.opacity,
    tileSize: row.tileSize === 512 ? 512 : 256,
    bounds: null,
    status: row.status as 'unknown' | 'ok' | 'error',
    statusMessage: row.statusMessage,
    lastCheckAt: row.lastCheckAt,
    canManage: manager,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Шаблон XYZ проверяется отдельно: у него обязательны `{z}`, `{x}`, `{y}`. */
function checkUrl(kind: string, url: string): void {
  if (kind !== 'xyz') return
  const parsed = RasterUrlTemplate.safeParse(url)
  if (!parsed.success) {
    throw errors.validation(parsed.error.issues[0]?.message ?? 'Некорректный шаблон адреса', [
      { path: 'url', message: parsed.error.issues[0]?.message ?? 'Некорректный шаблон' },
    ])
  }
}

const keyOf = (row: LoadedRow) => (row.secretEnc ? decryptSecret(row.secretEnc) : '')

/** Адрес запроса объектов у векторной службы. */
function featuresUrl(
  row: LoadedRow,
  bbox: string | undefined,
  limit: number,
  offset: number,
): string {
  const params = paramsOf(row)
  const url = new URL(row.url.replaceAll('{key}', encodeURIComponent(keyOf(row))))
  const search = url.searchParams
  if (params.kind === 'wfs') {
    search.set('SERVICE', 'WFS')
    search.set('VERSION', params.version)
    search.set('REQUEST', 'GetFeature')
    search.set(params.version === '2.0.0' ? 'TYPENAMES' : 'TYPENAME', params.typeName)
    search.set('OUTPUTFORMAT', 'application/json')
    search.set('SRSNAME', 'EPSG:4326')
    search.set(params.version === '2.0.0' ? 'COUNT' : 'MAXFEATURES', String(limit))
    if (offset > 0) search.set('STARTINDEX', String(offset))
    if (params.cql) search.set('CQL_FILTER', params.cql)
    if (bbox) search.set('BBOX', `${bbox},EPSG:4326`)
    return url.toString()
  }
  if (params.kind === 'arcgis') {
    const base = url.pathname.replace(/\/+$/, '')
    url.pathname = `${base}/${params.layer}/query`
    search.set('f', 'geojson')
    search.set('where', params.where || '1=1')
    search.set('outFields', params.outFields || '*')
    search.set('outSR', '4326')
    search.set('resultRecordCount', String(limit))
    if (offset > 0) search.set('resultOffset', String(offset))
    if (bbox) {
      search.set('geometry', bbox)
      search.set('geometryType', 'esriGeometryEnvelope')
      search.set('inSR', '4326')
      search.set('spatialRel', 'esriSpatialRelIntersects')
    }
    return url.toString()
  }
  throw errors.validation('У растровой службы объектов нет')
}

interface FeatureCollection {
  type: string
  features?: unknown[]
}

async function fetchFeatures(
  row: LoadedRow,
  bbox: string | undefined,
  limit: number,
  offset: number,
): Promise<FeatureCollection> {
  const response = await fetchExternal(featuresUrl(row, bbox, limit, offset), {
    accept: 'application/json, application/geo+json;q=0.9, */*;q=0.1',
    expect: '',
    maxBytes: FEATURES_MAX_BYTES,
    what: 'сервер объектов',
  })
  if (!response) return { type: 'FeatureCollection', features: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(response.body.toString('utf8'))
  } catch {
    throw errors.dependencyFailed('Служба вернула не GeoJSON')
  }
  const collection = parsed as FeatureCollection & { error?: { message?: string } }
  if (collection.error?.message) {
    throw errors.dependencyFailed(`Служба сообщила об ошибке: ${collection.error.message}`)
  }
  if (!Array.isArray(collection.features)) {
    throw errors.dependencyFailed('В ответе службы нет объектов GeoJSON')
  }
  return collection
}

export const SERVICE_LAYER_IMPORT_JOB = { queue: 'data', name: 'service_layer.export' } as const

export interface ServiceLayerImportJobData {
  serviceLayerId: string
  bbox?: string
  limit: number
  spaceId: string
}

export const ServiceLayerService = {
  async list(ctx: Ctx): Promise<ServiceLayerRecord[]> {
    const manager = hasCapability(ctx, MANAGE)
    const rows = await db()
      .select(columns)
      .from(serviceLayers)
      .innerJoin(objects, eq(objects.id, serviceLayers.id))
      .where(isNull(objects.deletedAt))
      .orderBy(asc(objects.title))
    const visible: ServiceLayerRecord[] = []
    for (const row of rows) {
      const decision = await authorize(ctx, 'view', row.id, { soft: true })
      if (decision.allowed) visible.push(toRecord(row, manager))
    }
    return visible
  },

  async get(ctx: Ctx, id: string): Promise<ServiceLayerRecord> {
    const row = await loadRow(id)
    if (!row) throw errors.notFound('Слой-ссылка')
    return toRecord(row, hasCapability(ctx, MANAGE))
  },

  async create(ctx: UserCtx, input: ServiceLayerCreateInput): Promise<ServiceLayerRecord> {
    requireCapability(ctx, MANAGE)
    checkUrl(input.kind, input.url)
    const id = await db().transaction(async (tx) => {
      // Служба принадлежит установке, а не автору: владельца нет, видят все
      const object = await ObjectService.create(tx, ctx, {
        type: 'service_layer',
        spaceId: null,
        title: input.name,
        subtitle: input.description ?? null,
        ownerId: null,
        meta: { kind: input.kind },
      })
      await tx.insert(serviceLayers).values({
        id: object.id,
        kind: input.kind,
        url: input.url,
        params: input.params as unknown as Record<string, unknown>,
        description: input.description ?? null,
        attribution: input.attribution ?? null,
        minZoom: input.minZoom,
        maxZoom: input.maxZoom,
        opacity: input.opacity,
        tileSize: input.tileSize,
        secretEnc: input.apiKey ? encryptSecret(input.apiKey) : null,
      })
      // Служба принадлежит установке: её видят все сотрудники, ведут — управляющие
      await grantAccess(
        tx,
        ctx,
        object.id,
        [{ principal: { type: 'everyone', id: '*' }, level: 'view' }],
        { quiet: true },
      )
      await publishEvent(tx, ctx, {
        type: 'service_layer.created',
        object: { id: object.id, type: 'service_layer', spaceId: null, title: input.name },
        payload: { kind: input.kind },
      })
      return object.id
    })
    return ServiceLayerService.get(ctx, id)
  },

  async update(
    ctx: UserCtx,
    id: string,
    input: ServiceLayerUpdateInput,
  ): Promise<ServiceLayerRecord> {
    await authorize(ctx, 'manage', id)
    await db().transaction(async (tx) => {
      const row = await loadRow(id, tx)
      if (!row) throw errors.notFound('Слой-ссылка')
      if (input.kind !== undefined && input.kind !== row.kind) {
        throw errors.validation('Вид службы менять нельзя — заведите новый слой-ссылку')
      }
      if (input.url !== undefined) checkUrl(row.kind, input.url)
      if (input.name !== undefined || input.description !== undefined) {
        await ObjectService.update(tx, ctx, id, {
          ...(input.name === undefined ? {} : { title: input.name }),
          ...(input.description === undefined ? {} : { subtitle: input.description }),
        })
      }
      const changed = Object.keys(input).filter(
        (key) => (input as Record<string, unknown>)[key] !== undefined,
      )
      await tx
        .update(serviceLayers)
        .set({
          ...(input.url === undefined ? {} : { url: input.url }),
          ...(input.params === undefined
            ? {}
            : { params: input.params as unknown as Record<string, unknown> }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
          ...(input.minZoom === undefined ? {} : { minZoom: input.minZoom }),
          ...(input.maxZoom === undefined ? {} : { maxZoom: input.maxZoom }),
          ...(input.opacity === undefined ? {} : { opacity: input.opacity }),
          ...(input.tileSize === undefined ? {} : { tileSize: input.tileSize }),
          ...(input.apiKey === undefined
            ? {}
            : { secretEnc: input.apiKey === null ? null : encryptSecret(input.apiKey) }),
        })
        .where(eq(serviceLayers.id, id))
      await publishEvent(tx, ctx, {
        type: 'service_layer.updated',
        object: { id, type: 'service_layer', spaceId: null, title: row.name },
        payload: { changed },
      })
    })
    return ServiceLayerService.get(ctx, id)
  },

  /** «Проверить соединение»: тайл или первая страница объектов. */
  async check(ctx: UserCtx, id: string): Promise<{ ok: boolean; message: string }> {
    await authorize(ctx, 'manage', id)
    const row = await loadRow(id)
    if (!row) throw errors.notFound('Слой-ссылка')
    let result: { ok: boolean; message: string }
    try {
      if (isRaster(row.kind)) {
        const z = Math.max(row.minZoom, 1)
        const tile = await ServiceLayerService.tile(id, z, 1, 1)
        result = tile
          ? { ok: true, message: `Тайл получен (${tile.contentType})` }
          : { ok: true, message: 'Служба ответила: тайла на этом масштабе нет' }
      } else {
        const collection = await fetchFeatures(row, undefined, 1, 0)
        result = { ok: true, message: `Объекты читаются: ${collection.features?.length ?? 0}` }
      }
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : 'Нет соединения' }
    }
    await db().transaction(async (tx) => {
      await tx
        .update(serviceLayers)
        .set({
          status: result.ok ? 'ok' : 'error',
          statusMessage: result.message,
          lastCheckAt: new Date().toISOString() as never,
        })
        .where(eq(serviceLayers.id, id))
      await publishEvent(tx, ctx, {
        type: 'service_layer.checked',
        object: { id, type: 'service_layer', spaceId: null, title: row.name },
        payload: { ok: result.ok, message: result.message },
      })
    })
    return result
  },

  /** Тайл растровой службы через прокси: ключ скрыт, ответ кэшируется. */
  async tile(
    id: string,
    z: number,
    x: number,
    y: number,
  ): Promise<{ body: Buffer; contentType: string } | null> {
    const row = await loadRow(id)
    if (!row || !isRaster(row.kind)) throw errors.notFound('Растровая служба')
    const limit = 2 ** z
    if (x >= limit || y >= limit) throw errors.validation('Тайл вне сетки масштаба')
    if (z < row.minZoom || z > row.maxZoom) return null

    const cacheKey = `kchs:service-layer:${id}:${tag(row)}:${z}/${x}/${y}`
    const cached = await redis().getBuffer(cacheKey)
    if (cached) {
      const contentType = (await redis().get(`${cacheKey}:ct`)) ?? 'image/png'
      return { body: cached, contentType }
    }
    const target = serviceTileUrl(
      {
        kind: row.kind as 'xyz' | 'wms' | 'wmts',
        url: row.url,
        service: row.kind === 'xyz' ? null : (paramsOf(row) as never),
        tileSize: row.tileSize,
      },
      z,
      x,
      y,
      keyOf(row),
    )
    const tile = await fetchExternal(target, {
      accept: 'image/*',
      expect: 'image/',
      maxBytes: 5 * 1024 * 1024,
      what: 'растровая служба',
    })
    if (!tile) return null
    await redis().set(cacheKey, tile.body, 'EX', SERVICE_LAYER_CACHE_TTL)
    await redis().set(`${cacheKey}:ct`, tile.contentType, 'EX', SERVICE_LAYER_CACHE_TTL)
    return tile
  },

  /** Объекты векторной службы в охвате — GeoJSON через прокси с кэшем. */
  async features(
    id: string,
    query: { bbox?: string | undefined; limit: number },
  ): Promise<{ body: string; truncated: boolean }> {
    const row = await loadRow(id)
    if (!row || isRaster(row.kind)) throw errors.notFound('Векторная служба')
    const limit = Math.min(query.limit, SERVICE_LAYER_FEATURES_LIMIT)
    const cacheKey = `kchs:service-layer:${id}:${tag(row)}:features:${query.bbox ?? 'all'}:${limit}`
    const cached = await redis().get(cacheKey)
    if (cached) return { body: cached, truncated: false }
    const collection = await fetchFeatures(row, query.bbox, limit, 0)
    const features = collection.features ?? []
    const body = JSON.stringify({ type: 'FeatureCollection', features })
    await redis().set(cacheKey, body, 'EX', SERVICE_LAYER_CACHE_TTL)
    return { body, truncated: features.length >= limit }
  },

  /**
   * Разовый импорт: объекты службы страницами → файл GeoJSON в хранилище →
   * запись файла. Дальше это обычный геоимпорт по `fileId` (ADR-0068).
   */
  async exportToFile(
    data: ServiceLayerImportJobData,
    helpers: { recordId: string; progress: (value: number, message?: string) => Promise<void> },
    ctx: Ctx,
  ): Promise<ServiceLayerImportResult> {
    const row = await loadRow(data.serviceLayerId)
    if (!row || isRaster(row.kind)) throw errors.notFound('Векторная служба')
    const features: unknown[] = []
    let truncated = false
    for (let offset = 0; offset < data.limit; offset += IMPORT_PAGE) {
      const page = Math.min(IMPORT_PAGE, data.limit - offset)
      const collection = await fetchFeatures(row, data.bbox, page, offset)
      const chunk = collection.features ?? []
      features.push(...chunk)
      await helpers.progress(
        Math.min(features.length / data.limit, 0.95),
        `Получено объектов: ${features.length}`,
      )
      if (chunk.length < page) break
      if (features.length >= data.limit) {
        truncated = true
        break
      }
    }
    const fileName = `${row.name.replace(/[^\p{L}\p{N}_ -]+/gu, '').trim() || 'service-layer'}.geojson`
    const body = Buffer.from(
      JSON.stringify({ type: 'FeatureCollection', features }, null, 0),
      'utf8',
    )
    const temporaryKey = storageKey(data.spaceId, newId(), newId(), fileName)
    await putObject(temporaryKey, body, {
      bucket: buckets.files(),
      contentType: 'application/geo+json',
    })
    const file = await registerStoredFile(ctx, {
      spaceId: data.spaceId,
      name: fileName,
      mime: 'application/geo+json',
      sourceKey: temporaryKey,
    })
    return { fileId: file.id, fileName, features: features.length, truncated }
  },
}
