import type { TerritoryLevel } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { db } from '~/shared/db/client.js'
import { objects, territories } from '~/shared/db/schema/index.js'

/** Геометрия GeoJSON в WGS 84 (точка, линия, полигон и их наборы). */
export interface LocatableGeometry {
  type: string
  coordinates: unknown
}

/**
 * Привязка к территории по границе (ADR-0132): для каждой геометрии — единица
 * заданного уровня, внутри границы которой лежит её точка на поверхности
 * (`ST_PointOnSurface`: у точки — она сама). Одним запросом на пачку, как
 * обратный геокодер (ADR-0067); вне справочника — null. Одноимённое наложение
 * границ не выбирает случайно: побеждает меньший код.
 */
export const TerritoryLocator = {
  async locate(
    geometries: ReadonlyArray<LocatableGeometry | null>,
    level: TerritoryLevel = 'district',
  ): Promise<Array<string | null>> {
    const result: Array<string | null> = geometries.map(() => null)
    const present = geometries.flatMap((geometry, index) => (geometry ? [{ index, geometry }] : []))
    if (present.length === 0) return result
    const rows = await db().execute<{ ord: number; id: string | null }>(sql`
      SELECT g.ord::int AS ord,
             (SELECT t.id FROM ${territories} t
                JOIN ${objects} o ON o.id = t.id AND o.deleted_at IS NULL
               WHERE t.level = ${level} AND t.geom IS NOT NULL
                 AND ST_Covers(t.geom, ST_PointOnSurface(
                       ST_SetSRID(ST_GeomFromGeoJSON(g.value::text), 4326)))
               ORDER BY t.code LIMIT 1) AS id
        FROM jsonb_array_elements(${JSON.stringify(present.map((item) => item.geometry))}::jsonb)
             WITH ORDINALITY AS g(value, ord)`)
    for (const row of rows) {
      const item = present[Number(row.ord) - 1]
      if (item) result[item.index] = row.id ?? null
    }
    return result
  },
}
