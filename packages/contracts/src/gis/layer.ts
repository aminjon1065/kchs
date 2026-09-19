import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'
import { LayerStyle } from './layer-style.js'

/**
 * Слой — объект реестра `layer`, представление датасета на карте
 * (07-gis-engine.md §1–4): стиль, подписи, карточка, фильтр, диапазон зумов,
 * поля тайла. У датасета может быть несколько слоёв; геометрия — поле датасета.
 */

export const LAYER_GEOMETRY_TYPES = ['point', 'line', 'polygon', 'mixed'] as const
export const LayerGeometryType = z.enum(LAYER_GEOMETRY_TYPES)
export type LayerGeometryType = z.infer<typeof LayerGeometryType>

/** Прямоугольник WGS 84: [запад, юг, восток, север]. */
export const Bbox = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
])
export type Bbox = z.infer<typeof Bbox>

const FieldKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z_][a-z0-9_]*$/)

export const LayerRecord = z.object({
  id: Uuid,
  name: z.string(),
  spaceId: Uuid,
  parentId: Uuid.nullable(),
  datasetId: Uuid,
  /** Поле геометрии датасета, которое рисует слой. */
  geometryField: z.string(),
  geometryType: LayerGeometryType,
  style: LayerStyle,
  /** Поля в тайле — для стиля, подписей и времени; остальное — по клику. */
  tileFields: z.array(z.string()),
  editable: z.boolean(),
  /** Правки не редакторов ждут проверки владельца слоя (07-gis-engine.md §7). */
  moderated: z.boolean(),
  /** Экстент строк датасета (без политик смотрящего) — null, если геометрий нет. */
  extent: Bbox.nullable(),
  featureCount: z.number().int().nonnegative(),
  /** Версия данных датасета — часть адреса тайлов (кэш по версии). */
  datasetVersion: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  updatedAt: Timestamp,
})
export type LayerRecord = z.infer<typeof LayerRecord>

export const LayerCreateInput = z.object({
  name: z.string().trim().min(1).max(200),
  spaceId: Uuid,
  parentId: Uuid.nullable().optional(),
  datasetId: Uuid,
  /** По умолчанию — первое поле геометрии датасета. */
  geometryField: FieldKey.optional(),
  /** По умолчанию — простой стиль по типу геометрии. */
  style: LayerStyle.optional(),
  tileFields: z.array(FieldKey).max(32).optional(),
  editable: z.boolean().default(false),
  moderated: z.boolean().default(false),
})
export type LayerCreateInput = z.infer<typeof LayerCreateInput>

export const LayerUpdateInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  style: LayerStyle.optional(),
  tileFields: z.array(FieldKey).max(32).optional(),
  editable: z.boolean().optional(),
  moderated: z.boolean().optional(),
})
export type LayerUpdateInput = z.infer<typeof LayerUpdateInput>

/**
 * Параметры тайлов и объектов слоя: версия данных (кэш), фильтр карты поверх
 * фильтра слоя (привязка к фильтрам дашборда) и интервал времени.
 */
export const LayerTileQuery = z.object({
  v: z.coerce.number().int().nonnegative().optional(),
  /** FilterNode в JSON, закодированный в base64url (связанные представления, дашборд). */
  f: z.string().max(8000).optional(),
  /** Интервал времени `from/to` в ISO 8601 для слоя со временем. */
  t: z.string().max(80).optional(),
})
export type LayerTileQuery = z.infer<typeof LayerTileQuery>

/** Объект слоя для карточки: все видимые смотрящему поля строки и геометрия GeoJSON. */
export const LayerFeature = z.object({
  id: z.string(),
  ver: z.number().int(),
  values: z.record(z.string(), z.unknown()),
  geometry: z.record(z.string(), z.unknown()).nullable(),
})
export type LayerFeature = z.infer<typeof LayerFeature>

export const LayerFeatureCollection = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(
    z.object({
      type: z.literal('Feature'),
      id: z.string(),
      geometry: z.record(z.string(), z.unknown()).nullable(),
      properties: z.record(z.string(), z.unknown()),
    }),
  ),
  /** Строк больше лимита — показаны первые. */
  truncated: z.boolean(),
})
export type LayerFeatureCollection = z.infer<typeof LayerFeatureCollection>
