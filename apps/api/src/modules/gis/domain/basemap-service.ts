import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import {
  type Basemap,
  type BasemapCreateInput,
  BasemapKind,
  BasemapServiceParams,
  type BasemapStyleQuery,
  type BasemapUpdateInput,
  Bbox,
  basemapUrlIssue,
  RASTER_BASEMAP_KINDS,
  type RasterBasemapKind,
} from '@kchs/contracts'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { grantAccess } from '~/kernel/access/acl-service.js'
import {
  authorize,
  hasCapability,
  requireCapability,
  visibleObjectsSql,
} from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { ObjectService } from '~/kernel/objects/service.js'
import {
  buckets,
  deletePrefix,
  getObjectStream,
  isMissingObject,
  putObject,
} from '~/kernel/storage/s3.js'
import { config } from '~/shared/config/index.js'
import type { Ctx } from '~/shared/context.js'
import { decryptSecret, encryptSecret } from '~/shared/crypto/secrets.js'
import { db, type Executor } from '~/shared/db/client.js'
import { basemaps, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import {
  type BasemapManifest,
  basemapKeys,
  readManifests,
  removeBuild,
  removeStaleArchives,
} from './basemap-storage.js'
import { basemapStyle, type StyleContent } from './basemap-style.js'
import { fetchRasterTile } from './raster-fetch.js'
import { serviceTileUrl } from './service-url.js'

const MANAGE = 'gis.basemaps.manage'
/** Системная подложка «только фон»: есть всегда, удалить нельзя. */
const NONE_KEY = 'none'
const NONE_NAME = 'Без подложки'

/** Сведения сборки PMTiles в `basemaps.style`. */
const VectorInfo = z.object({
  version: z.string(),
  file: z.string(),
  bytes: z.number(),
  tiles: z.number(),
  sha256: z.string(),
  bounds: Bbox,
  center: z.tuple([z.number(), z.number(), z.number()]),
  layers: z.array(z.string()),
})
type VectorInfo = z.infer<typeof VectorInfo>

const RasterInfo = z.object({
  tileSize: z.union([z.literal(256), z.literal(512)]),
  /** Параметры внешней службы WMS/WMTS (ADR-0108). */
  service: BasemapServiceParams.optional(),
})

/** Растровые виды подложки: тайлы идут через прокси API. */
const isRaster = (kind: string): kind is RasterBasemapKind =>
  (RASTER_BASEMAP_KINDS as readonly string[]).includes(kind)

const serviceOf = (row: Row): BasemapServiceParams | null =>
  RasterInfo.safeParse(row.style).data?.service ?? null

const columns = {
  id: basemaps.id,
  key: basemaps.key,
  kind: basemaps.kind,
  url: basemaps.url,
  style: basemaps.style,
  attribution: basemaps.attribution,
  minZoom: basemaps.minZoom,
  maxZoom: basemaps.maxZoom,
  isDefault: basemaps.isDefault,
  secretEnc: basemaps.secretEnc,
  name: objects.title,
  version: objects.version,
  updatedAt: objects.updatedAt,
}

type Row = {
  id: string
  key: string | null
  kind: string
  url: string | null
  style: Record<string, unknown>
  attribution: string | null
  minZoom: number
  maxZoom: number
  isDefault: boolean
  secretEnc: Buffer | null
  name: string
  version: number
  updatedAt: string
}

async function loadRow(id: string, executor: Executor = db()): Promise<Row | null> {
  const [row] = await executor
    .select(columns)
    .from(basemaps)
    .innerJoin(objects, eq(objects.id, basemaps.id))
    .where(and(eq(basemaps.id, id), isNull(objects.deletedAt)))
    .limit(1)
  return (row as Row | undefined) ?? null
}

const vectorInfo = (row: Row): VectorInfo | null =>
  row.kind === 'vector' ? (VectorInfo.safeParse(row.style).data ?? null) : null

const tileSize = (row: Row): 256 | 512 => RasterInfo.safeParse(row.style).data?.tileSize ?? 256

function toBasemap(row: Row, manager: boolean): Basemap {
  const kind = BasemapKind.parse(row.kind)
  const vector = vectorInfo(row)
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    kind,
    isDefault: row.isDefault,
    attribution: row.attribution,
    minZoom: row.minZoom,
    maxZoom: row.maxZoom,
    bounds: vector?.bounds ?? null,
    build: vector ? { version: vector.version, bytes: vector.bytes, tiles: vector.tiles } : null,
    url: isRaster(kind) && manager ? row.url : null,
    hasKey: row.secretEnc !== null,
    tileSize: isRaster(kind) ? tileSize(row) : null,
    service: manager ? serviceOf(row) : null,
    version: row.version,
    updatedAt: row.updatedAt,
  }
}

/** Атрибуция сборки (HTML Planetiler) → текст: в стиль попадает только экранированный текст. */
function htmlToText(value: string | null): string | null {
  if (!value) return null
  const text = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&copy;/g, '©')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  return text || null
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** MapLibre вставляет атрибуцию как HTML — ввод администратора только текстом. */
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)

/** Метка адреса растрового сервера: смена адреса или параметров начинает кэш заново. */
const rasterTag = (row: Row) =>
  createHash('sha256')
    .update(`${row.url ?? ''}|${tileSize(row)}|${JSON.stringify(serviceOf(row) ?? {})}`)
    .digest('hex')
    .slice(0, 12)

const apiBase = () => `${config().KCHS_BASE_URL.replace(/\/+$/, '')}/api/v1`

function vectorContent(manifest: BasemapManifest) {
  return {
    url: basemapKeys.archive(manifest.key, manifest.file),
    style: {
      version: manifest.version,
      file: manifest.file,
      bytes: manifest.bytes,
      tiles: manifest.tiles,
      sha256: manifest.sha256,
      bounds: manifest.bounds,
      center: manifest.center,
      layers: manifest.layers,
    } satisfies VectorInfo,
    attribution: htmlToText(manifest.attribution),
    minZoom: manifest.minZoom,
    maxZoom: manifest.maxZoom,
  }
}

/** Шаблон `{key}` и ключ доступа идут парой; у служб ключ необязателен. */
function checkKey(url: string, hasKey: boolean, kind: string = 'raster'): void {
  if (kind !== 'raster') {
    if (hasKey && !url.includes('{key}')) {
      throw errors.validation('Ключ доступа не используется: добавьте {key} в адрес службы', [
        { path: 'url', message: 'Добавьте {key} в адрес' },
      ])
    }
    return
  }
  const needsKey = url.includes('{key}')
  if (needsKey && !hasKey) {
    throw errors.validation('Шаблон содержит {key} — укажите ключ доступа', [
      { path: 'apiKey', message: 'Укажите ключ доступа' },
    ])
  }
  if (!needsKey && hasKey) {
    throw errors.validation('Ключ доступа не используется: добавьте {key} в шаблон адреса', [
      { path: 'url', message: 'Добавьте {key} в шаблон' },
    ])
  }
}

async function insertBasemap(
  tx: Executor,
  ctx: Ctx,
  values: Omit<typeof basemaps.$inferInsert, 'id'> & { name: string; build?: string },
): Promise<string> {
  const { name, build, ...row } = values
  // Подложка принадлежит установке, а не автору: владельца нет, видят все сотрудники
  const object = await ObjectService.create(tx, ctx, {
    type: 'basemap',
    spaceId: null,
    title: name,
    ownerId: null,
    meta: { kind: row.kind, ...(build ? { build } : {}) },
  })
  await tx.insert(basemaps).values({ ...row, id: object.id })
  await grantAccess(
    tx,
    ctx,
    object.id,
    [{ principal: { type: 'everyone', id: '*' }, level: 'view' }],
    { quiet: true },
  )
  return object.id
}

async function markDefault(tx: Executor, ctx: Ctx, id: string): Promise<void> {
  const [current] = await tx
    .select({ id: basemaps.id })
    .from(basemaps)
    .where(eq(basemaps.isDefault, true))
    .for('update')
  if (current?.id === id) return
  // Сначала снимаем признак: уникальный индекс допускает одну подложку по умолчанию
  await tx
    .update(basemaps)
    .set({ isDefault: false, updatedAt: sql`now()` })
    .where(eq(basemaps.isDefault, true))
  await tx
    .update(basemaps)
    .set({ isDefault: true, updatedAt: sql`now()` })
    .where(eq(basemaps.id, id))
  const [object] = await tx
    .select({ title: objects.title })
    .from(objects)
    .where(eq(objects.id, id))
    .limit(1)
  await publishEvent(tx, ctx, {
    type: 'basemap.default_changed',
    object: { id, type: 'basemap', spaceId: null, title: object?.title },
    payload: { previousId: current?.id ?? null },
  })
}

/** Изменение параметров: версия объекта растёт (кэши клиента), событие — с полями. */
async function recordChange(
  tx: Executor,
  ctx: Ctx,
  id: string,
  meta: Record<string, unknown>,
  changed: string[],
) {
  const object = await ObjectService.update(
    tx,
    ctx,
    id,
    { meta, mergeMeta: true },
    { silent: true },
  )
  await publishEvent(tx, ctx, {
    type: 'basemap.updated',
    object: { id, type: 'basemap', spaceId: null, title: object.title },
    payload: { changed },
  })
}

export interface BasemapSyncSummary {
  created: string[]
  updated: string[]
  /** Подложка по умолчанию после синхронизации. */
  defaultName: string | null
  defaultKind: BasemapKind | null
  /** Манифесты прочитаны; иначе зарегистрирована только «без подложки». */
  storageAvailable: boolean
}

export interface ArchiveResponse {
  status: 200 | 206 | 416
  headers: Record<string, string>
  body: Readable | null
}

const RANGE = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/

/** Один диапазон `bytes=a-b`, `bytes=a-`, `bytes=-n`; нет заголовка — null. */
function parseRange(header: string | undefined): string | null | 'invalid' {
  if (header === undefined) return null
  const value = header.trim()
  const match = RANGE.exec(value)
  if (!match) return 'invalid'
  if (match[1] !== undefined && match[2] && Number(match[2]) < Number(match[1])) return 'invalid'
  if (match[3] !== undefined && Number(match[3]) === 0) return 'invalid'
  return value
}

/**
 * Реестр базовых карт (07-gis-engine.md §5, ADR-0066). Подложка — объект
 * реестра `basemap` без пространства и владельца, видимый всем сотрудникам
 * (ACL `everyone:view`); управление — способность `gis.basemaps.manage`
 * (действие `manage` типа). Стиль, архив и растровые тайлы отдаются маршрутами
 * с проверкой `view` — методы отдачи права не перепроверяют.
 */
export const BasemapService = {
  async list(ctx: Ctx): Promise<Basemap[]> {
    const rows = await db()
      .select(columns)
      .from(basemaps)
      .innerJoin(objects, eq(objects.id, basemaps.id))
      .where(and(isNull(objects.deletedAt), visibleObjectsSql(ctx, 'basemap')))
      .orderBy(desc(basemaps.isDefault), asc(objects.title))
    const manager = hasCapability(ctx, MANAGE)
    return rows.map((row) => toBasemap(row as Row, manager))
  },

  async get(ctx: Ctx, id: string): Promise<Basemap> {
    await authorize(ctx, 'view', id)
    const row = await loadRow(id)
    if (!row) throw errors.notFound('Базовая карта')
    return toBasemap(row, hasCapability(ctx, MANAGE))
  },

  /** Растровая XYZ-подложка; векторные регистрирует `sync` по манифестам сборок. */
  async create(ctx: Ctx, input: BasemapCreateInput): Promise<Basemap> {
    requireCapability(ctx, MANAGE)
    checkKey(input.url, Boolean(input.apiKey), input.kind)
    const id = await db().transaction(async (tx) => {
      const created = await insertBasemap(tx, ctx, {
        name: input.name,
        key: null,
        kind: input.kind,
        url: input.url,
        style: {
          tileSize: input.tileSize,
          ...(input.service ? { service: input.service } : {}),
        },
        attribution: input.attribution,
        minZoom: input.minZoom,
        maxZoom: input.maxZoom,
        secretEnc: input.apiKey ? encryptSecret(input.apiKey) : null,
      })
      if (input.isDefault) await markDefault(tx, ctx, created)
      return created
    })
    return BasemapService.get(ctx, id)
  },

  async update(ctx: Ctx, id: string, input: BasemapUpdateInput): Promise<Basemap> {
    await authorize(ctx, 'manage', id)
    const clearCache = await db().transaction(async (tx) => {
      const row = await loadRow(id, tx)
      if (!row) throw errors.notFound('Базовая карта')
      const { name, ...rest } = input
      const technical = Object.values(rest).some((value) => value !== undefined)
      if (technical && !isRaster(row.kind)) {
        throw errors.validation('У этой подложки меняется только название')
      }
      if (input.kind !== undefined && technical && input.kind !== row.kind) {
        throw errors.validation('Вид подложки менять нельзя — заведите новую')
      }
      if (name !== undefined && name !== row.name) {
        await ObjectService.update(tx, ctx, id, { title: name })
      }
      if (!technical) return false

      const url = input.url ?? row.url ?? ''
      const secretEnc =
        input.apiKey === undefined
          ? row.secretEnc
          : input.apiKey === null
            ? null
            : encryptSecret(input.apiKey)
      const urlIssue = basemapUrlIssue(row.kind, url)
      if (urlIssue) throw errors.validation(urlIssue, [{ path: 'url', message: urlIssue }])
      checkKey(url, secretEnc !== null, row.kind)
      const minZoom = input.minZoom ?? row.minZoom
      const maxZoom = input.maxZoom ?? row.maxZoom
      if (minZoom > maxZoom) {
        throw errors.validation('Минимальный масштаб больше максимального', [
          { path: 'minZoom', message: 'Больше максимального' },
        ])
      }
      const size = input.tileSize ?? tileSize(row)
      const service = input.service ?? serviceOf(row)
      const changed = [
        ...(input.service !== undefined &&
        JSON.stringify(input.service) !== JSON.stringify(serviceOf(row))
          ? ['service']
          : []),
        ...(input.url !== undefined && input.url !== row.url ? ['url'] : []),
        ...(input.apiKey !== undefined ? ['apiKey'] : []),
        ...(input.attribution !== undefined && input.attribution !== row.attribution
          ? ['attribution']
          : []),
        ...(minZoom !== row.minZoom ? ['minZoom'] : []),
        ...(maxZoom !== row.maxZoom ? ['maxZoom'] : []),
        ...(size !== tileSize(row) ? ['tileSize'] : []),
      ]
      if (changed.length === 0) return false
      await tx
        .update(basemaps)
        .set({
          url,
          secretEnc,
          attribution: input.attribution === undefined ? row.attribution : input.attribution,
          minZoom,
          maxZoom,
          style: { tileSize: size, ...(service ? { service } : {}) },
          updatedAt: sql`now()`,
        })
        .where(eq(basemaps.id, id))
      await recordChange(tx, ctx, id, { kind: row.kind }, changed)
      return changed.includes('url') || changed.includes('tileSize') || changed.includes('service')
    })
    // Кэш прежнего адреса больше не читается — освобождаем место
    if (clearCache) {
      await deletePrefix(basemapKeys.rasterCache(id), buckets.tiles()).catch((error: unknown) =>
        logger().warn({ err: error, basemapId: id }, 'кэш растровой подложки не очищен'),
      )
    }
    return BasemapService.get(ctx, id)
  },

  async setDefault(ctx: Ctx, id: string): Promise<void> {
    await authorize(ctx, 'manage', id)
    await db().transaction((tx) => markDefault(tx, ctx, id))
  },

  /**
   * Удаление: системную «без подложки» и подложку по умолчанию удалить нельзя.
   * Файлы уходят после фиксации: кэш растровой, архив и манифест сборки
   * векторной (иначе `sync` зарегистрировал бы её снова).
   */
  async remove(ctx: Ctx, id: string): Promise<void> {
    await authorize(ctx, 'manage', id)
    const row = await db().transaction(async (tx) => {
      const current = await loadRow(id, tx)
      if (!current) throw errors.notFound('Базовая карта')
      if (current.key === NONE_KEY) {
        throw errors.conflict('Системную подложку «без подложки» удалить нельзя')
      }
      if (current.isDefault) {
        throw errors.conflict('Сначала назначьте другую подложку по умолчанию')
      }
      await ObjectService.purge(tx, ctx, id)
      return current
    })
    const cleanup =
      row.kind === 'vector' && row.key
        ? removeBuild(row.key)
        : deletePrefix(basemapKeys.rasterCache(id), buckets.tiles())
    await Promise.resolve(cleanup).catch((error: unknown) =>
      logger().warn({ err: error, basemapId: id }, 'файлы удалённой подложки не очищены'),
    )
  },

  /** Стиль MapLibre темы с абсолютными адресами через API (07-gis-engine.md §5). */
  async style(id: string, query: BasemapStyleQuery): Promise<Record<string, unknown>> {
    const row = await loadRow(id)
    if (!row) throw errors.notFound('Базовая карта')
    const base = apiBase()
    let content: StyleContent = { kind: 'none' }
    const vector = vectorInfo(row)
    if (vector) {
      content = {
        kind: 'vector',
        archive: `${base}/gis/basemaps/${id}/pmtiles/${vector.file}`,
        attribution: row.attribution ? escapeHtml(row.attribution) : null,
        center: vector.center,
      }
    } else if (isRaster(row.kind)) {
      content = {
        kind: 'raster',
        tiles: `${base}/gis/basemaps/${id}/tiles/{z}/{x}/{y}?v=${rasterTag(row)}`,
        tileSize: tileSize(row),
        minZoom: row.minZoom,
        maxZoom: row.maxZoom,
        attribution: row.attribution ? escapeHtml(row.attribution) : null,
        bounds: null,
      }
    }
    return basemapStyle({
      id,
      name: row.name,
      theme: query.theme,
      lang: query.lang,
      urls: {
        glyphs: `${base}/gis/glyphs/{fontstack}/{range}.pbf`,
        sprite: `${base}/gis/sprites/basemap-${query.theme}`,
      },
      content,
    })
  },

  /**
   * Архив PMTiles диапазонами (Range → 206) из хранилища: клиент MapLibre с
   * протоколом `pmtiles://` читает заголовок, каталоги и тайлы. Адрес содержит
   * файл версии — прошлая версия после обновления отвечает 404.
   */
  async archive(id: string, file: string, range: string | undefined): Promise<ArchiveResponse> {
    const row = await loadRow(id)
    const vector = row ? vectorInfo(row) : null
    if (!row?.url || !vector || vector.file !== file) throw errors.notFound('Архив подложки')
    const requested = parseRange(range)
    const unsatisfiable: ArchiveResponse = {
      status: 416,
      headers: { 'content-range': `bytes */${vector.bytes}` },
      body: null,
    }
    if (requested === 'invalid') return unsatisfiable
    try {
      const object = await getObjectStream(row.url, {
        bucket: buckets.tiles(),
        range: requested ?? undefined,
      })
      const headers: Record<string, string> = {
        'content-type': 'application/octet-stream',
        'accept-ranges': 'bytes',
        // Адрес меняется с версией сборки — содержимое по нему неизменно
        'cache-control': 'private, max-age=86400, immutable',
      }
      if (object.contentLength !== null) headers['content-length'] = String(object.contentLength)
      if (object.etag) headers.etag = object.etag
      if (requested && object.contentRange) headers['content-range'] = object.contentRange
      return { status: requested ? 206 : 200, headers, body: object.body }
    } catch (error) {
      if ((error as { name?: string }).name === 'InvalidRange') return unsatisfiable
      if (isMissingObject(error)) throw errors.notFound('Архив подложки')
      throw error
    }
  },

  /**
   * Растровый тайл через прокси (скрытие ключа, кэш в хранилище). null — тайла
   * нет (вне масштабов подложки или у сервера).
   */
  async rasterTile(
    id: string,
    z: number,
    x: number,
    y: number,
  ): Promise<{ body: Buffer; contentType: string } | null> {
    const row = await loadRow(id)
    if (!row?.url || !isRaster(row.kind)) throw errors.notFound('Растровая подложка')
    const limit = 2 ** z
    if (x >= limit || y >= limit) throw errors.validation('Тайл вне сетки масштаба')
    if (z < row.minZoom || z > row.maxZoom) return null

    const cacheKey = basemapKeys.rasterTile(id, rasterTag(row), z, x, y)
    try {
      const cached = await getObjectStream(cacheKey, { bucket: buckets.tiles() })
      const chunks: Buffer[] = []
      for await (const chunk of cached.body) chunks.push(chunk as Buffer)
      return { body: Buffer.concat(chunks), contentType: cached.contentType ?? 'image/png' }
    } catch (error) {
      if (!isMissingObject(error)) {
        logger().warn({ err: error, basemapId: id }, 'кэш растровой подложки недоступен')
      }
    }

    const key = row.secretEnc ? decryptSecret(row.secretEnc) : ''
    const target = serviceTileUrl(
      {
        kind: row.kind === 'raster' ? 'xyz' : (row.kind as 'wms' | 'wmts'),
        url: row.url,
        service: serviceOf(row),
        tileSize: tileSize(row),
      },
      z,
      x,
      y,
      key,
    )
    const tile = await fetchRasterTile(target)
    if (!tile) return null
    await putObject(cacheKey, tile.body, {
      bucket: buckets.tiles(),
      contentType: tile.contentType,
    }).catch((error: unknown) =>
      logger().warn({ err: error, basemapId: id }, 'тайл не записан в кэш растровой подложки'),
    )
    return tile
  },

  /**
   * Реестр ↔ хранилище (`kchs init`, `kchs seed`, `kchs basemaps sync`): «без
   * подложки» есть всегда; сборки из манифестов регистрируются или переходят на
   * новую версию; без подложки по умолчанию — первая векторная, иначе «без
   * подложки». Векторная сборка сменяет по умолчанию и системную «без подложки».
   */
  async sync(ctx: Ctx): Promise<BasemapSyncSummary> {
    // Хранилище недоступно — установка всё равно получает «без подложки»
    let storageAvailable = true
    const manifests = await readManifests().catch((error: unknown) => {
      logger().warn({ err: error }, 'манифесты базовых карт не прочитаны')
      storageAvailable = false
      return []
    })
    const summary = await db().transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('kchs:basemaps'))`)
      // Подложки в корзине остаются в карте ключей (ключ занят), но не выбираются
      const rows = await tx
        .select({
          id: basemaps.id,
          key: basemaps.key,
          kind: basemaps.kind,
          style: basemaps.style,
          trashed: sql<boolean>`${objects.deletedAt} IS NOT NULL`,
        })
        .from(basemaps)
        .innerJoin(objects, eq(objects.id, basemaps.id))
      const byKey = new Map(rows.filter((row) => row.key).map((row) => [row.key as string, row]))
      const created: string[] = []
      const updated: string[] = []

      if (!byKey.has(NONE_KEY)) {
        const id = await insertBasemap(tx, ctx, {
          name: NONE_NAME,
          key: NONE_KEY,
          kind: 'none',
          url: null,
          style: {},
          attribution: null,
          minZoom: 0,
          maxZoom: 24,
        })
        byKey.set(NONE_KEY, { id, key: NONE_KEY, kind: 'none', style: {}, trashed: false })
        created.push(NONE_KEY)
      }

      let firstVector: string | null = null
      for (const manifest of manifests) {
        const content = vectorContent(manifest)
        const existing = byKey.get(manifest.key)
        if (!existing) {
          const id = await insertBasemap(tx, ctx, {
            name: manifest.name,
            build: manifest.version,
            key: manifest.key,
            kind: 'vector',
            ...content,
          })
          firstVector ??= id
          created.push(manifest.key)
          continue
        }
        if (existing.kind !== 'vector' || existing.trashed) {
          logger().warn(
            { key: manifest.key },
            'ключ сборки занят подложкой другого вида или в корзине',
          )
          continue
        }
        const current = VectorInfo.safeParse(existing.style).data
        if (current?.file === manifest.file && current.sha256 === manifest.sha256) continue
        await tx
          .update(basemaps)
          .set({ ...content, updatedAt: sql`now()` })
          .where(eq(basemaps.id, existing.id))
        await recordChange(tx, ctx, existing.id, { kind: 'vector', build: manifest.version }, [
          'build',
        ])
        updated.push(manifest.key)
      }

      // Подложка по умолчанию в корзине (общий маршрут объектов) считается отсутствующей
      const [current] = await tx
        .select({ id: basemaps.id, key: basemaps.key })
        .from(basemaps)
        .innerJoin(objects, eq(objects.id, basemaps.id))
        .where(and(eq(basemaps.isDefault, true), isNull(objects.deletedAt)))
      const noneId = byKey.get(NONE_KEY)?.id ?? null
      const fallback =
        rows.find((row) => row.kind === 'vector' && !row.trashed)?.id ?? firstVector ?? noneId
      if (!current && fallback) await markDefault(tx, ctx, fallback)
      else if (current?.key === NONE_KEY && firstVector) await markDefault(tx, ctx, firstVector)

      const [chosen] = await tx
        .select({ name: objects.title, kind: basemaps.kind })
        .from(basemaps)
        .innerJoin(objects, eq(objects.id, basemaps.id))
        .where(eq(basemaps.isDefault, true))
      return {
        created,
        updated,
        defaultName: chosen?.name ?? null,
        defaultKind: chosen ? BasemapKind.parse(chosen.kind) : null,
        storageAvailable,
      }
    })
    // Прошлые версии архивов больше не адресуются
    for (const manifest of manifests) {
      await removeStaleArchives(manifest.key, manifest.file).catch((error: unknown) =>
        logger().warn({ err: error, key: manifest.key }, 'прошлые версии подложки не удалены'),
      )
    }
    return summary
  },
}
