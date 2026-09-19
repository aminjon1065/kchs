import { createHash } from 'node:crypto'
import { type Locale, TERRITORY_LEVELS, type TerritoryLevel } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { db } from '~/shared/db/client.js'
import { objects, territories } from '~/shared/db/schema/index.js'
import { redis } from '~/shared/redis/index.js'
import { simplifyTolerance, TerritoryService } from './territory-service.js'

const EXTENT = 4096
const BUFFER = 64
const CACHE_TTL_SECONDS = 24 * 60 * 60

/** С какого зума уровень попадает в тайл, если уровни не заданы. */
const MIN_ZOOM: Record<TerritoryLevel, number> = {
  country: 0,
  region: 0,
  district: 5,
  jamoat: 8,
  settlement: 9,
}

export interface TerritoryTileRequest {
  z: number
  x: number
  y: number
  levels: TerritoryLevel[]
  locale: Locale
}

/** Уровни тайла: заданные через запятую или все, что видны на этом зуме. */
export function tileLevels(zoom: number, level: string | undefined): TerritoryLevel[] {
  if (!level) return TERRITORY_LEVELS.filter((item) => zoom >= MIN_ZOOM[item])
  const requested = new Set(level.split(','))
  return TERRITORY_LEVELS.filter((item) => requested.has(item))
}

/** Слой MVT одного уровня: границы упрощены до пикселя, населённые пункты — точки. */
async function layerTile(request: TerritoryTileRequest, level: TerritoryLevel): Promise<Buffer> {
  const { z, x, y, locale } = request
  const tolerance = simplifyTolerance(z)
  const point = level === 'settlement'
  const source = point ? sql`t.centroid` : sql`t.geom`
  const shape =
    !point && tolerance > 0 ? sql`ST_SimplifyPreserveTopology(t.geom, ${tolerance})` : source
  const [row] = await db().execute<{ tile: Buffer | null }>(sql`
    WITH bounds AS (
      SELECT ST_TileEnvelope(${z}, ${x}, ${y}) AS tile,
             ST_Transform(ST_TileEnvelope(${z}, ${x}, ${y}, margin => ${BUFFER / EXTENT}), 4326) AS area
    ), features AS (
      SELECT t.id::text AS id, t.code, t.level,
             coalesce(t.name ->> ${locale}, t.name ->> 'ru') AS name,
             ST_AsMVTGeom(ST_Transform(${shape}, 3857), bounds.tile, ${EXTENT}, ${BUFFER}, true) AS geom
        FROM ${territories} t
        JOIN ${objects} o ON o.id = t.id AND o.deleted_at IS NULL
        CROSS JOIN bounds
       WHERE t.level = ${level} AND ${source} && bounds.area
    )
    SELECT ST_AsMVT(features, ${level}, ${EXTENT}, 'geom') AS tile
      FROM features WHERE geom IS NOT NULL`)
  return row?.tile ?? Buffer.alloc(0)
}

/**
 * Векторные тайлы границ справочника (07-gis-engine.md §3, §11): слой на уровень,
 * у объекта `id`, `code`, `level` и название на языке. Кэш — Redis на сутки; версия
 * справочника в ключе и ETag, поэтому после загрузки границ старые тайлы не отдаются.
 */
export const TerritoryTiles = {
  /** Метка тайла — версия справочника и параметры запроса. */
  async tag(request: TerritoryTileRequest): Promise<{ key: string; etag: string }> {
    const version = await TerritoryService.version()
    const { z, x, y, levels, locale } = request
    const key = `kchs:gis:territory-tile:${version}:${levels.join(',')}:${locale}:${z}/${x}/${y}`
    const etag = `"${createHash('sha256').update(key).digest('base64url').slice(0, 27)}"`
    return { key, etag }
  },

  /** Тайл MVT; пустой буфер — в тайле ничего нет. */
  async render(request: TerritoryTileRequest, key: string): Promise<Buffer> {
    const cached = await redis().getBuffer(key)
    if (cached) return cached
    const layers: Buffer[] = []
    for (const level of request.levels) layers.push(await layerTile(request, level))
    const tile = Buffer.concat(layers)
    await redis().set(key, tile, 'EX', CACHE_TTL_SECONDS)
    return tile
  },
}
