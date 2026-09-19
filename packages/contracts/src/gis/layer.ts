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
  /**
   * Смотрящий видит данные датасета. Права на слой данных не открывают: без
   * доступа к датасету слой в студии — «нет доступа», тайлы не запрашиваются.
   */
  dataAccess: z.boolean(),
  /**
   * Экстент строк, видимых смотрящему (под политикой строк — только своих), — null,
   * если геометрий нет или нет доступа.
   */
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
  /** Предпросмотр рабочей копии стиля: `LayerTilePreview` в JSON, закодированный в base64url. */
  p: z.string().max(8000).optional(),
})
export type LayerTileQuery = z.infer<typeof LayerTileQuery>

/**
 * Предпросмотр рабочей копии стиля (редактор стиля, ADR-0075): то, что стиль
 * меняет в тайле и объектах слоя, — поля, фильтр слоя, кластеры, масштабы и
 * время. Передаётся как `p`; сохранённый стиль не меняется, строки и поля — с
 * политиками смотрящего, как у любого тайла.
 */
export const LayerTilePreview = z.object({
  /** Поля стиля в тайле (`layerStyleTileFields` рабочей копии). */
  fields: z.array(FieldKey).max(32).default([]),
  filter: LayerStyle.shape.filter,
  cluster: LayerStyle.shape.cluster,
  minZoom: LayerStyle.shape.minZoom,
  maxZoom: LayerStyle.shape.maxZoom,
  time: LayerStyle.shape.time,
})
export type LayerTilePreview = z.infer<typeof LayerTilePreview>

/** Лимит GeoJSON-объектов слоя: крупные слои читаются тайлами (07-gis-engine.md §3). */
export const LAYER_FEATURES_LIMIT = 5000

/** Объекты слоя в охвате — мелкие слои и режим правки. */
export const LayerFeaturesQuery = LayerTileQuery.extend({
  /** Охват «запад,юг,восток,север» в WGS 84; без него — весь слой. */
  bbox: z
    .string()
    .max(200)
    .regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(LAYER_FEATURES_LIMIT).default(LAYER_FEATURES_LIMIT),
})
export type LayerFeaturesQuery = z.infer<typeof LayerFeaturesQuery>

/** Слои датасета, видимые смотрящему, — «Показать на карте». */
export const LayerList = z.object({
  items: z.array(z.object({ id: Uuid, name: z.string() })),
})
export type LayerList = z.infer<typeof LayerList>

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
