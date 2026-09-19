import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { BigIntString, Timestamp, Uuid } from '../common/primitives.js'

/**
 * Правка объектов слоя на карте (07-gis-engine.md §7, ADR-0076): геометрия
 * GeoJSON в WGS 84, запись строки датасета через слой с версией строки,
 * предложения правок модерируемого слоя и их проверка.
 */

const Lon = z.number().min(-180).max(180)
const Lat = z.number().min(-90).max(90)

/** Координата [долгота, широта]; высота допускается и отбрасывается при записи. */
export const GeoPosition = z.tuple([Lon, Lat], z.number())
export type GeoPosition = z.infer<typeof GeoPosition>

/** Вершин в одной геометрии не больше — крупнее правят импортом. */
const MAX_POSITIONS = 100_000

const LinePositions = z.array(GeoPosition).min(2).max(MAX_POSITIONS)

/** Кольцо полигона: не меньше четырёх координат, первая совпадает с последней. */
const Ring = z
  .array(GeoPosition)
  .min(4)
  .max(MAX_POSITIONS)
  .refine(
    (ring) => {
      const first = ring[0]
      const last = ring[ring.length - 1]
      return Boolean(first && last && first[0] === last[0] && first[1] === last[1])
    },
    { message: 'Кольцо полигона не замкнуто' },
  )

const PolygonRings = z.array(Ring).min(1).max(1000)

export const FeatureGeometry = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Point'), coordinates: GeoPosition }),
  z.object({
    type: z.literal('MultiPoint'),
    coordinates: z.array(GeoPosition).min(1).max(MAX_POSITIONS),
  }),
  z.object({ type: z.literal('LineString'), coordinates: LinePositions }),
  z.object({ type: z.literal('MultiLineString'), coordinates: z.array(LinePositions).min(1) }),
  z.object({ type: z.literal('Polygon'), coordinates: PolygonRings }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(PolygonRings).min(1) }),
])
export type FeatureGeometry = z.infer<typeof FeatureGeometry>

const Values = z.record(z.string(), z.unknown())
const Ver = z.number().int().positive()

/** Новый объект слоя: значения полей (без геометрии) и геометрия. */
export const LayerFeatureInput = z.object({
  values: Values.default({}),
  geometry: FeatureGeometry,
})
export type LayerFeatureInput = z.infer<typeof LayerFeatureInput>

/** Правка объекта: изменённые поля, новая геометрия и версия строки, которую видел пользователь. */
export const LayerFeaturePatch = z.object({
  values: Values.default({}),
  /** Без поля — геометрия прежняя. */
  geometry: FeatureGeometry.optional(),
  ver: Ver,
})
export type LayerFeaturePatch = z.infer<typeof LayerFeaturePatch>

/** Удаление объекта (параметры адреса): версия строки, которую видел пользователь. */
export const LayerFeatureDelete = z.object({ ver: z.coerce.number().int().positive() })
export type LayerFeatureDelete = z.infer<typeof LayerFeatureDelete>

/**
 * Как пользователь правит объекты слоя: напрямую, предложением на проверку
 * (модерируемый слой) или никак.
 */
export const LAYER_EDIT_MODES = ['direct', 'suggest', 'none'] as const
export const LayerEditMode = z.enum(LAYER_EDIT_MODES)
export type LayerEditMode = z.infer<typeof LayerEditMode>

/**
 * Почему правки нет: слой не редактируется, нет данных, правка датасета
 * выключена, строки ограничены политикой, нет прав на слой или датасет.
 */
export const LAYER_EDIT_REASONS = [
  'layer_readonly',
  'no_data_access',
  'dataset_readonly',
  'row_policy',
  'no_rights',
] as const
export const LayerEditReason = z.enum(LAYER_EDIT_REASONS)
export type LayerEditReason = z.infer<typeof LayerEditReason>

export const LayerEditAccess = z.object({
  mode: LayerEditMode,
  /** Для `none` — почему нельзя; для `suggest` — почему не напрямую. */
  reason: LayerEditReason.nullable(),
  /** Модерируемый слой: пользователь проверяет правки других. */
  canReview: z.boolean(),
  /** Правок на проверке: проверяющему — всех, остальным — своих. */
  pending: z.number().int().nonnegative(),
})
export type LayerEditAccess = z.infer<typeof LayerEditAccess>

export const FEATURE_EDIT_OPS = ['create', 'update', 'delete'] as const
export const FeatureEditOp = z.enum(FEATURE_EDIT_OPS)
export type FeatureEditOp = z.infer<typeof FeatureEditOp>

export const FEATURE_EDIT_STATUSES = ['pending', 'approved', 'rejected'] as const
export const FeatureEditStatus = z.enum(FEATURE_EDIT_STATUSES)
export type FeatureEditStatus = z.infer<typeof FeatureEditStatus>

const Note = z.string().trim().max(2000).optional()

/** Предложение правки модерируемого слоя: создать, изменить или удалить объект. */
export const FeatureEditInput = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    values: Values.default({}),
    geometry: FeatureGeometry,
    note: Note,
  }),
  z.object({
    op: z.literal('update'),
    rowId: BigIntString,
    ver: Ver,
    values: Values.default({}),
    geometry: FeatureGeometry.optional(),
    note: Note,
  }),
  z.object({ op: z.literal('delete'), rowId: BigIntString, ver: Ver, note: Note }),
])
export type FeatureEditInput = z.infer<typeof FeatureEditInput>

export const FeatureEdit = z.object({
  id: BigIntString,
  layerId: Uuid,
  datasetId: Uuid,
  /** Строка правки; у принятого создания — новая строка, до решения — null. */
  rowId: BigIntString.nullable(),
  op: FeatureEditOp,
  /** Предложенные значения полей (без геометрии). */
  values: Values,
  /** Предложенная геометрия GeoJSON; null — геометрия не меняется. */
  geometry: z.record(z.string(), z.unknown()).nullable(),
  /** Версия строки, от которой сделана правка (изменение и удаление). */
  baseVer: z.number().int().nullable(),
  note: z.string().nullable(),
  status: FeatureEditStatus,
  author: UserRef.nullable(),
  reviewer: UserRef.nullable(),
  comment: z.string().nullable(),
  createdAt: Timestamp,
  reviewedAt: Timestamp.nullable(),
})
export type FeatureEdit = z.infer<typeof FeatureEdit>

export const FeatureEditList = z.object({ items: z.array(FeatureEdit) })
export type FeatureEditList = z.infer<typeof FeatureEditList>

export const FeatureEditsQuery = z.object({
  status: FeatureEditStatus.optional(),
  /** `mine` — свои правки; `all` — все правки слоя (проверяющему, остальным — свои). */
  scope: z.enum(['all', 'mine']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})
export type FeatureEditsQuery = z.infer<typeof FeatureEditsQuery>

export const FeatureEditReview = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().trim().max(2000).optional(),
  /** Строку изменили после подачи правки: применить поверх текущей версии. */
  force: z.boolean().default(false),
})
export type FeatureEditReview = z.infer<typeof FeatureEditReview>
