import type { Bbox, DatasetField, LayerGeometryType } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { redis } from '~/shared/redis/index.js'
import { ident, qualified } from '../infra/physical.js'
import { DatasetService } from './dataset-service.js'

/** Экстент и тип геометрии пересчитываются только с новой версией данных. */
const CACHE_TTL_SECONDS = 3600
/** Тип геометрии слоя определяется по выборке строк — таблица может быть большой. */
const TYPE_SAMPLE = 1000
const DIMENSION_TYPES: Record<number, LayerGeometryType> = { 0: 'point', 1: 'line', 2: 'polygon' }
/**
 * Пустой датасет: тип — из описания поля (слой для рисования с нуля, ADR-0076),
 * без него — точки.
 */
const DECLARED_TYPES: Record<string, LayerGeometryType> = {
  point: 'point',
  line: 'line',
  polygon: 'polygon',
  any: 'mixed',
}

export interface DatasetGeometry {
  datasetId: string
  field: DatasetField
  /** Версия данных — часть адреса тайлов и ключа кэша. */
  version: number
  rowCount: number
  spaceId: string
  geometryType: LayerGeometryType
  /** Экстент строк без удалённых (без политик смотрящего: метаданные слоя). */
  extent: Bbox | null
}

/**
 * Геометрия датасета для модуля GIS (ADR-0064): поле, тип по выборке строк и
 * экстент — по физической таблице, с кэшем по версии данных. Данные строк
 * наружу не отдаются: тайлы и объекты читаются только через компилятор с
 * политиками смотрящего.
 */
export const DatasetGeo = {
  /** Поля геометрии датасета — по порядку схемы. */
  async geometryFields(datasetId: string): Promise<DatasetField[]> {
    const storage = await DatasetService.storage(datasetId)
    return storage.fields
      .filter((field) => field.type === 'geometry')
      .map(({ physical: _physical, ...field }) => field)
  },

  async describe(datasetId: string, fieldKey?: string): Promise<DatasetGeometry> {
    const storage = await DatasetService.storage(datasetId)
    const field = fieldKey
      ? storage.fields.find((item) => item.key === fieldKey)
      : storage.fields.find((item) => item.type === 'geometry')
    if (field?.type !== 'geometry') {
      throw errors.validation(
        fieldKey ? `В датасете нет поля геометрии «${fieldKey}»` : 'В датасете нет поля геометрии',
      )
    }
    const key = `kchs:geo:${datasetId}:${storage.currentVersion}:${field.key}`
    const cached = await redis().get(key)
    let summary: { geometryType: LayerGeometryType; extent: Bbox | null; rowCount: number }
    if (cached) {
      summary = JSON.parse(cached) as typeof summary
    } else {
      const table = qualified(storage.table)
      const column = ident(field.physical)
      const [extent] = await db().execute<{
        minx: number | null
        miny: number | null
        maxx: number | null
        maxy: number | null
        rows: number
      }>(
        sql.raw(`SELECT ST_XMin(e) AS minx, ST_YMin(e) AS miny, ST_XMax(e) AS maxx, ST_YMax(e) AS maxy,
                        (SELECT count(*)::int FROM ${table} WHERE _deleted_at IS NULL) AS rows
                   FROM (SELECT ST_Extent(${column}) AS e FROM ${table}
                          WHERE _deleted_at IS NULL AND ${column} IS NOT NULL) x`),
      )
      const dimensions = await db().execute<{ dimension: number }>(
        sql.raw(`SELECT DISTINCT ST_Dimension(${column}) AS dimension
                   FROM (SELECT ${column} FROM ${table}
                          WHERE _deleted_at IS NULL AND ${column} IS NOT NULL
                          LIMIT ${TYPE_SAMPLE}) sample`),
      )
      const types = new Set(dimensions.map((row) => DIMENSION_TYPES[Number(row.dimension)]))
      const declared = DECLARED_TYPES[field.geometryType ?? 'point'] ?? 'point'
      const geometryType: LayerGeometryType =
        types.size === 1 ? ([...types][0] ?? 'mixed') : types.size === 0 ? declared : 'mixed'
      summary = {
        geometryType,
        extent:
          extent && extent.minx !== null && extent.miny !== null && extent.maxx !== null
            ? [
                Number(extent.minx),
                Number(extent.miny),
                Number(extent.maxx),
                Number(extent.maxy ?? extent.miny),
              ]
            : null,
        rowCount: Number(extent?.rows ?? 0),
      }
      await redis().set(key, JSON.stringify(summary), 'EX', CACHE_TTL_SECONDS)
    }
    const { physical: _physical, ...publicField } = field
    return {
      datasetId,
      field: publicField,
      version: storage.currentVersion,
      rowCount: summary.rowCount,
      spaceId: storage.spaceId,
      geometryType: summary.geometryType,
      extent: summary.extent,
    }
  },
}
