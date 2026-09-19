import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { gzip as gzipCallback } from 'node:zlib'
import { type FieldType, type LayerTileQuery, QuerySpec } from '@kchs/contracts'
import { cacheKeyText } from '@kchs/query'
import { DatasetQueries } from '~/modules/data/public.js'
import type { Ctx } from '~/shared/context.js'
import { queryRoleSql } from '~/shared/db/client.js'
import { pgErrorCode } from '~/shared/db/pg-error.js'
import { errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { redis } from '~/shared/redis/index.js'
import { layerConditions } from './layer-filter.js'
import { LayerService } from './layer-service.js'
import { styleTileFields } from './style-fields.js'

/** Размер сетки MVT и запас по краю (подписи и символы не обрезаются на стыке тайлов). */
const EXTENT = 4096
const BUFFER = 64
/** Тайл, который не уложился, — пустой ответ с подсказкой (07-gis-engine.md §3). */
const TILE_TIMEOUT_MS = 5000
const CACHE_TTL_SECONDS = 24 * 3600
/** Логический размер тайла MapLibre для векторных источников, px. */
const TILE_PX = 512
const QUERY_CANCELED = '57014'
const NUMERIC = new Set<FieldType>(['integer', 'number', 'decimal', 'money', 'percent'])
const TEMPORAL = new Set<FieldType>(['date', 'datetime'])
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

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`

/**
 * Значение поля в тайле: числа — числами, даты и время — миллисекундами эпохи
 * (фильтры и анимация времени на клиенте), списки — через «|», остальное — текст.
 */
function tileValue(column: string, type: FieldType | undefined): string {
  if (type === 'boolean') return column
  if (type && NUMERIC.has(type)) return `${column}::double precision`
  if (type && TEMPORAL.has(type)) return `(extract(epoch FROM ${column}) * 1000)::double precision`
  if (type === 'multi_select') return `array_to_string(${column}, '|')`
  return `${column}::text`
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
    const empty = (etag: string): TileResult => ({
      body: null,
      etag,
      cached: false,
      timedOut: false,
      sqlMs: null,
    })
    if (z < Math.floor(style.minZoom) || z > Math.ceil(style.maxZoom)) {
      return empty(`"z-${layer.version}"`)
    }

    const visible = await DatasetQueries.visibleFields(ctx, layer.datasetId)
    // Геометрия, скрытая политикой столбцов, — нет и слоя: место объекта тоже данные
    if (!visible.has(layer.geometryField)) throw errors.forbidden()
    // Поля стиля и тайла, видимые смотрящему: скрытое политикой в тайл не попадает
    const fields = [...new Set([...styleTileFields(style), ...layer.tileFields])].filter(
      (key) => key !== layer.geometryField && visible.has(key),
    )
    // Охват тайла с запасом по краю — пространственное окно компилятора: рамка
    // `&&` рядом с политикой строк, по индексу GIST. Для точек сравнение рамок
    // точное, линии и полигоны вне тайла обрезает ST_AsMVTGeom (пустые
    // отбрасываются). В спецификации — фильтр слоя, фильтр карты и время
    const [west, south, east, north] = tileBounds(z, x, y)
    const padX = ((east - west) * BUFFER) / EXTENT
    const padY = ((north - south) * BUFFER) / EXTENT
    const where = layerConditions(layer, query)
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

    const cluster =
      style.geometry === 'point' && style.cluster?.enabled && z <= style.cluster.maxZoom
        ? style.cluster
        : null
    const hash = createHash('sha256')
      .update(
        `${cacheKeyText(compiled.cacheKeyParts)}|${schemaVersions}|${layer.version}|${z}/${x}/${y}`,
      )
      .digest('hex')
    const key = `kchs:tile:${layerId}:${hash}`
    const etag = `"${hash.slice(0, 32)}"`
    const hit = await redis().getBuffer(key)
    if (hit) {
      return { body: hit.length > 0 ? hit : null, etag, cached: true, timedOut: false, sqlMs: null }
    }

    // Параметры компиляции — первыми, тайловые — следом
    const params: unknown[] = [...compiled.params]
    const param = (value: unknown, type: string) => {
      params.push(value)
      return `$${params.length}::${type}`
    }
    const envelope = `ST_TileEnvelope(${param(z, 'int')}, ${param(x, 'int')}, ${param(y, 'int')})`
    const geom = `src.${quote(layer.geometryField)}`
    const pixel = 360 / limit / TILE_PX
    const values = fields.map((field) => ({
      key: field,
      sql: tileValue(`src.${quote(field)}`, visible.get(field)),
    }))
    const columns = values.map((value) => `, ${value.sql} AS ${quote(value.key)}`).join('')
    let body: string
    if (cluster) {
      // Сетка в градусах: ячейка ≈ радиусу кластера в пикселях, по широте — с
      // поправкой Меркатора по середине тайла, чтобы ячейки на карте были квадратными.
      // Координаты извлекаются один раз (OFFSET 0 не даёт планировщику повторять
      // ST_X/ST_Y в группировке и агрегатах); группы — по целым номерам ячеек;
      // центр кластера — среднее координат, значения полей — у одиночной точки
      const cell = pixel * cluster.radius
      const latCell = cell * Math.cos((((south + north) / 2) * Math.PI) / 180)
      const cellX = param(cell, 'float8')
      const cellY = param(latCell, 'float8')
      const single = values
        .map(
          (value) =>
            `, CASE WHEN count(*) = 1 THEN any_value(p.${quote(value.key)}) END AS ${quote(value.key)}`,
        )
        .join('')
      body = `SELECT min(p._id) AS _id, count(*)::int AS point_count${single},
                     ST_AsMVTGeom(ST_Transform(ST_SetSRID(ST_MakePoint(sum(p.gx) / count(*), sum(p.gy) / count(*)), 4326), 3857),
                                  ${envelope}, ${EXTENT}, ${BUFFER}, true) AS geom
                FROM (SELECT src."_id"::bigint AS _id${columns}, ST_X(${geom}) AS gx, ST_Y(${geom}) AS gy
                        FROM (${compiled.sql}) src
                       WHERE ${geom} IS NOT NULL
                      OFFSET 0) p
               GROUP BY floor(p.gx / ${cellX})::int, floor(p.gy / ${cellY})::int`
    } else {
      const simplified =
        style.geometry === 'point'
          ? geom
          : `ST_SimplifyPreserveTopology(${geom}, ${param(pixel / 2, 'float8')})`
      body = `SELECT src."_id"::bigint AS _id${columns},
                     ST_AsMVTGeom(ST_Transform(${simplified}, 3857), ${envelope}, ${EXTENT}, ${BUFFER}, true) AS geom
                FROM (${compiled.sql}) src
               WHERE ${geom} IS NOT NULL`
    }
    const tileSql = `SELECT ST_AsMVT(tile, 'layer', ${EXTENT}, 'geom', '_id') AS mvt
                       FROM (${body}) tile WHERE tile.geom IS NOT NULL`

    const started = performance.now()
    let mvt: Buffer | null | undefined
    try {
      const rows = await queryRoleSql().begin('read only', async (sql) => {
        await sql`SELECT set_config('statement_timeout', ${String(TILE_TIMEOUT_MS)}, true)`
        return sql.unsafe(tileSql, params as never[])
      })
      mvt = (rows[0] as { mvt?: Buffer | null } | undefined)?.mvt
    } catch (error) {
      if (pgErrorCode(error) === QUERY_CANCELED) {
        logger().warn({ layerId, z, x, y }, 'тайл слоя не уложился в тайм-аут')
        return { ...empty(etag), timedOut: true }
      }
      throw error
    }
    const sqlMs = performance.now() - started
    const buffer = mvt && mvt.length > 0 ? await gzip(mvt) : Buffer.alloc(0)
    await redis().set(key, buffer, 'EX', CACHE_TTL_SECONDS)
    return { body: buffer.length > 0 ? buffer : null, etag, cached: false, timedOut: false, sqlMs }
  },
}
