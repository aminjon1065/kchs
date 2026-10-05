import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { gzip as gzipCallback } from 'node:zlib'
import { type LayerTileQuery, layerStyleTileFields, QuerySpec } from '@kchs/contracts'
import { cacheKeyText } from '@kchs/query'
import { DatasetQueries } from '~/modules/data/public.js'
import type { Ctx } from '~/shared/context.js'
import { pgErrorCode } from '~/shared/db/pg-error.js'
import { readAsQueryRole } from '~/shared/db/query-role.js'
import { errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { cache } from '~/shared/redis/index.js'
import { BUFFER, EXTENT, tileSql } from '../infra/layer-sql.js'
import { layerConditions, tilePreview } from './layer-filter.js'
import { LayerService } from './layer-service.js'

/** Тайл, который не уложился, — пустой ответ с подсказкой (07-gis-engine.md §3). */
const TILE_TIMEOUT_MS = 5000
const CACHE_TTL_SECONDS = 24 * 3600
/** Логический размер тайла MapLibre для векторных источников, px. */
const TILE_PX = 512
const QUERY_CANCELED = '57014'
const gzip = promisify(gzipCallback)

export interface TileResult {
  /** Тайл MVT, сжатый gzip; пустой — null (ответ 204). */
  body: Buffer | null
  etag: string
  cached: boolean
  /** Запрос не уложился в тайм-аут: включите кластеры или генерализацию. */
  timedOut: boolean
  sqlMs: number | null
}

/** Границы тайла в WGS 84: [запад, юг, восток, север]. */
export function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z
  const lon = (column: number) => (column / n) * 360 - 180
  const lat = (row: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)]
}

/**
 * Векторные тайлы слоя (07-gis-engine.md §3, ADR-0064): строки — через компилятор
 * с политиками смотрящего (права и фильтры в SQL), геометрия как есть, обёртка
 * `ST_AsMVT`; точки на мелких масштабах — кластеры сеткой с `point_count`,
 * линии и полигоны — упрощение по пикселю. Кэш — Redis по ключу компиляции
 * (версия данных, политика, условия) и версии слоя.
 */
export const TileService = {
  async tile(
    ctx: Ctx,
    layerId: string,
    z: number,
    x: number,
    y: number,
    query: LayerTileQuery,
  ): Promise<TileResult> {
    const limit = 2 ** z
    if (x >= limit || y >= limit) throw errors.validation('Тайл вне сетки масштаба')
    const layer = await LayerService.load(layerId)
    const style = layer.style
    // Рабочая копия стиля из редактора: её поля, фильтр, кластеры и масштабы (ADR-0075)
    const preview = tilePreview(query.p)
    const minZoom = preview?.minZoom ?? style.minZoom
    const maxZoom = preview?.maxZoom ?? style.maxZoom
    const empty = (etag: string): TileResult => ({
      body: null,
      etag,
      cached: false,
      timedOut: false,
      sqlMs: null,
    })
    if (z < Math.floor(minZoom) || z > Math.ceil(maxZoom)) {
      return empty(`"z-${layer.version}"`)
    }

    const visible = await DatasetQueries.visibleFields(ctx, layer.datasetId)
    // Геометрия, скрытая политикой столбцов, — нет и слоя: место объекта тоже данные
    if (!visible.has(layer.geometryField)) throw errors.forbidden()
    // Поля стиля и тайла, видимые смотрящему: скрытое политикой в тайл не попадает
    const styleFields = preview ? preview.fields : layerStyleTileFields(style)
    const fields = [...new Set([...styleFields, ...layer.tileFields])].filter(
      (key) => key !== layer.geometryField && visible.has(key),
    )
    // Охват тайла с запасом по краю — пространственное окно компилятора: рамка
    // `&&` рядом с политикой строк, по индексу GIST. Для точек сравнение рамок
    // точное, линии и полигоны вне тайла обрезает ST_AsMVTGeom (пустые
    // отбрасываются). В спецификации — фильтр слоя, фильтр карты и время
    const [west, south, east, north] = tileBounds(z, x, y)
    const padX = ((east - west) * BUFFER) / EXTENT
    const padY = ((north - south) * BUFFER) / EXTENT
    const where = layerConditions(layer, query, preview)
    const spec = QuerySpec.parse({
      version: 1,
      source: { kind: 'dataset', id: layer.datasetId },
      steps: [
        ...(where ? [{ type: 'filter', where }] : []),
        { type: 'select', fields: [layer.geometryField, ...fields] },
      ],
      options: { cache: false },
    })
    const { compiled, schemaVersions } = await DatasetQueries.compile(ctx, spec, {
      geometryOutput: 'raw',
      maxRows: null,
      rowMeta: true,
      spatialWindow: {
        datasetId: layer.datasetId,
        field: layer.geometryField,
        bbox: [
          Math.max(-180, west - padX),
          Math.max(-90, south - padY),
          Math.min(180, east + padX),
          Math.min(90, north + padY),
        ],
      },
    })

    const clustering = preview ? preview.cluster : style.cluster
    const cluster =
      style.geometry === 'point' && clustering?.enabled && z <= clustering.maxZoom
        ? clustering
        : null
    // Кластеры предпросмотра — не в спецификации запроса, поэтому в ключе отдельно
    const previewKey = preview ? `|p:${JSON.stringify(cluster)}` : ''
    const hash = createHash('sha256')
      .update(
        `${cacheKeyText(compiled.cacheKeyParts)}|${schemaVersions}|${layer.version}|${z}/${x}/${y}${previewKey}`,
      )
      .digest('hex')
    const key = `kchs:tile:${layerId}:${hash}`
    const etag = `"${hash.slice(0, 32)}"`
    const hit = await cache.getBuffer(key)
    if (hit) {
      return { body: hit.length > 0 ? hit : null, etag, cached: true, timedOut: false, sqlMs: null }
    }

    // Сетка кластеров в градусах: ячейка ≈ радиусу кластера в пикселях, по широте — с
    // поправкой Меркатора по середине тайла, чтобы ячейки на карте были квадратными
    const pixel = 360 / limit / TILE_PX
    const cell = cluster ? pixel * cluster.radius : 0
    const mvtQuery = tileSql({
      rows: compiled,
      z,
      x,
      y,
      geometryField: layer.geometryField,
      fields: fields.map((key) => ({ key, type: visible.get(key) })),
      shape: cluster
        ? {
            cluster: {
              cellX: cell,
              cellY: cell * Math.cos((((south + north) / 2) * Math.PI) / 180),
            },
          }
        : { simplify: style.geometry === 'point' ? null : pixel / 2 },
    })

    const started = performance.now()
    let mvt: Buffer | null | undefined
    try {
      const rows = await readAsQueryRole({ timeoutMs: TILE_TIMEOUT_MS }, (read) =>
        read.rows(mvtQuery),
      )
      mvt = rows[0]?.mvt as Buffer | null | undefined
    } catch (error) {
      if (pgErrorCode(error) === QUERY_CANCELED) {
        logger().warn({ layerId, z, x, y }, 'тайл слоя не уложился в тайм-аут')
        return { ...empty(etag), timedOut: true }
      }
      throw error
    }
    const sqlMs = performance.now() - started
    const buffer = mvt && mvt.length > 0 ? await gzip(mvt) : Buffer.alloc(0)
    await cache.set(key, buffer, CACHE_TTL_SECONDS)
    return { body: buffer.length > 0 ? buffer : null, etag, cached: false, timedOut: false, sqlMs }
  },
}
