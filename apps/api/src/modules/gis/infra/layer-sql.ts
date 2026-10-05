import type { FieldType } from '@kchs/contracts'
import { quoteIdent } from '@kchs/query'
import type { QueryText } from '~/shared/db/query-role.js'

/**
 * Текст SQL слоя вокруг запроса строк компилятора (ADR-0064, ADR-0184): тайл MVT и
 * экстент в пределах политики смотрящего. Строки, права и фильтры — в SQL
 * компилятора `@kchs/query`, здесь — только обёртка: в текст попадают SQL
 * компилятора и имена полей через `quoteIdent`, координаты тайла и размеры —
 * параметрами после параметров компиляции.
 */

/** Размер сетки MVT и запас по краю (подписи и символы не обрезаются на стыке тайлов). */
export const EXTENT = 4096
export const BUFFER = 64

const NUMERIC = new Set<FieldType>(['integer', 'number', 'decimal', 'money', 'percent'])
const TEMPORAL = new Set<FieldType>(['date', 'datetime'])

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

export interface TileSqlInput {
  /** Строки слоя от компилятора с политиками смотрящего. */
  rows: QueryText
  z: number
  x: number
  y: number
  geometryField: string
  /** Поля тайла и их типы. */
  fields: ReadonlyArray<{ key: string; type: FieldType | undefined }>
  /**
   * Кластеры сеткой: ячейка в градусах по долготе и широте. Без них — строки как
   * есть, линии и полигоны упрощаются на `simplify` градусов (null — без упрощения).
   */
  shape: { cluster: { cellX: number; cellY: number } } | { simplify: number | null }
}

/** Тайл слоя: `ST_AsMVT` по строкам компилятора — кластерами или упрощёнными фигурами. */
export function tileSql(input: TileSqlInput): QueryText {
  // Параметры компиляции — первыми, тайловые — следом
  const params: unknown[] = [...input.rows.params]
  const param = (value: unknown, type: string) => {
    params.push(value)
    return `$${params.length}::${type}`
  }
  const envelope = `ST_TileEnvelope(${param(input.z, 'int')}, ${param(input.x, 'int')}, ${param(input.y, 'int')})`
  const geom = `src.${quoteIdent(input.geometryField)}`
  const values = input.fields.map((field) => ({
    key: field.key,
    sql: tileValue(`src.${quoteIdent(field.key)}`, field.type),
  }))
  const columns = values.map((value) => `, ${value.sql} AS ${quoteIdent(value.key)}`).join('')
  let body: string
  if ('cluster' in input.shape) {
    // Координаты извлекаются один раз (OFFSET 0 не даёт планировщику повторять
    // ST_X/ST_Y в группировке и агрегатах); группы — по целым номерам ячеек;
    // центр кластера — среднее координат, значения полей — у одиночной точки
    const cellX = param(input.shape.cluster.cellX, 'float8')
    const cellY = param(input.shape.cluster.cellY, 'float8')
    const single = values
      .map(
        (value) =>
          `, CASE WHEN count(*) = 1 THEN any_value(p.${quoteIdent(value.key)}) END AS ${quoteIdent(value.key)}`,
      )
      .join('')
    body = `SELECT min(p._id) AS _id, count(*)::int AS point_count${single},
                   ST_AsMVTGeom(ST_Transform(ST_SetSRID(ST_MakePoint(sum(p.gx) / count(*), sum(p.gy) / count(*)), 4326), 3857),
                                ${envelope}, ${EXTENT}, ${BUFFER}, true) AS geom
              FROM (SELECT src."_id"::bigint AS _id${columns}, ST_X(${geom}) AS gx, ST_Y(${geom}) AS gy
                      FROM (${input.rows.sql}) src
                     WHERE ${geom} IS NOT NULL
                    OFFSET 0) p
             GROUP BY floor(p.gx / ${cellX})::int, floor(p.gy / ${cellY})::int`
  } else {
    const simplified =
      input.shape.simplify === null
        ? geom
        : `ST_SimplifyPreserveTopology(${geom}, ${param(input.shape.simplify, 'float8')})`
    body = `SELECT src."_id"::bigint AS _id${columns},
                   ST_AsMVTGeom(ST_Transform(${simplified}, 3857), ${envelope}, ${EXTENT}, ${BUFFER}, true) AS geom
              FROM (${input.rows.sql}) src
             WHERE ${geom} IS NOT NULL`
  }
  return {
    sql: `SELECT ST_AsMVT(tile, 'layer', ${EXTENT}, 'geom', '_id') AS mvt
            FROM (${body}) tile WHERE tile.geom IS NOT NULL`,
    params,
  }
}

/** Экстент и число объектов по строкам компилятора: `minx…maxy` и `c`. */
export function extentSql(rows: QueryText, geometryField: string): QueryText {
  const geom = `src.${quoteIdent(geometryField)}`
  return {
    sql: `SELECT ST_XMin(e) AS minx, ST_YMin(e) AS miny, ST_XMax(e) AS maxx, ST_YMax(e) AS maxy, c
            FROM (SELECT ST_Extent(${geom}) AS e, count(${geom})::int AS c FROM (${rows.sql}) src) x`,
    params: rows.params,
  }
}
