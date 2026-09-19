import type { FeatureGeometry, LayerGeometryType } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'

type Family = Exclude<LayerGeometryType, 'mixed'>

/** Код типа для `ST_CollectionExtract`: исправление может вернуть коллекцию. */
const EXTRACT: Record<Family, number> = { point: 1, line: 2, polygon: 3 }

const FAMILY: Record<string, Family> = {
  Point: 'point',
  MultiPoint: 'point',
  LineString: 'line',
  MultiLineString: 'line',
  Polygon: 'polygon',
  MultiPolygon: 'polygon',
}

/** Семейство геометрии GeoJSON: точки, линии, полигоны (одиночные и составные). */
export function geometryFamily(type: string): Family | null {
  return FAMILY[type] ?? null
}

/** Геометрия подходит слою: смешанный слой принимает любую. */
export function fitsLayer(type: string, layerType: LayerGeometryType): boolean {
  const family = geometryFamily(type)
  return family !== null && (layerType === 'mixed' || family === layerType)
}

/**
 * Геометрия к записи (07-gis-engine.md §2): тип подходит слою, высота
 * отбрасывается, некорректная исправляется `ST_MakeValid` (из коллекции —
 * части своего семейства), внешние кольца полигонов — против часовой стрелки
 * (RFC 7946). Пустой результат (полигон схлопнулся в линию) — ошибка.
 */
export async function normalizeGeometry(
  geometry: FeatureGeometry,
  layerType: LayerGeometryType,
): Promise<FeatureGeometry> {
  if (!fitsLayer(geometry.type, layerType)) {
    throw errors.validation(`Слой не принимает геометрию «${geometry.type}»`, [
      { path: 'geometry', message: 'Тип геометрии не подходит слою', code: 'geometry_type' },
    ])
  }
  const family = geometryFamily(geometry.type) as Family
  let row: { geojson: string | null; empty: boolean | null } | undefined
  try {
    ;[row] = await db().execute<{ geojson: string | null; empty: boolean | null }>(
      sql`SELECT extensions.ST_AsGeoJSON(g) AS geojson, extensions.ST_IsEmpty(g) AS empty
            FROM (SELECT extensions.ST_ForcePolygonCCW(extensions.ST_CollectionExtract(
                    extensions.ST_MakeValid(extensions.ST_Force2D(extensions.ST_SetSRID(
                      extensions.ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326))),
                    ${EXTRACT[family]}::int)) AS g) n`,
    )
  } catch {
    throw errors.validation('Геометрия не читается', [
      { path: 'geometry', message: 'Некорректная геометрия GeoJSON', code: 'geometry_invalid' },
    ])
  }
  const parsed = row?.geojson ? (JSON.parse(row.geojson) as FeatureGeometry) : null
  if (!parsed || row?.empty || geometryFamily(parsed.type) !== family) {
    throw errors.validation('Геометрия вырождена — проверьте вершины', [
      { path: 'geometry', message: 'Геометрия вырождена', code: 'geometry_degenerate' },
    ])
  }
  return parsed
}
