import { z } from 'zod'
import { LangText, Locale, Uuid } from '../common/primitives.js'
import { Bbox } from './layer.js'

/**
 * Территории — сквозной справочник административного деления (07-gis-engine.md
 * §11, ADR-0057): объект реестра типа `territory`, иерархия с замыканием.
 * Уровни — от страны до населённого пункта; границы районов, регионов и страны и
 * населённые пункты демо-профиля — с фазы 2 (ADR-0067).
 */
export const TERRITORY_LEVELS = ['country', 'region', 'district', 'jamoat', 'settlement'] as const
export const TerritoryLevel = z.enum(TERRITORY_LEVELS)
export type TerritoryLevel = z.infer<typeof TerritoryLevel>

export const LonLat = z.object({ lon: z.number(), lat: z.number() })
export type LonLat = z.infer<typeof LonLat>

/** Территория справочника: всё, что нужно дереву, пикеру и подписям. */
export const Territory = z.object({
  id: Uuid,
  code: z.string(),
  parentId: Uuid.nullable(),
  level: TerritoryLevel,
  name: LangText,
  /** Вид единицы: «область», «город», «район города»… */
  kind: z.string().nullable(),
  centroid: LonLat.nullable(),
})
export type Territory = z.infer<typeof Territory>

export const TerritoryList = z.object({ items: z.array(Territory) })
export type TerritoryList = z.infer<typeof TerritoryList>

/** Карточка территории: путь от корня, дочерние единицы и атрибуты. */
export const TerritoryDetail = Territory.extend({
  path: z.array(Territory),
  children: z.array(Territory),
  attributes: z.record(z.string(), z.unknown()),
  areaKm2: z.number().nullable(),
  hasGeometry: z.boolean(),
  /** Экстент границы; у единицы без границы (населённый пункт) — null. */
  bbox: Bbox.nullable(),
})
export type TerritoryDetail = z.infer<typeof TerritoryDetail>

export const TerritoryGeometryQuery = z.object({
  /** Зум карты: граница упрощается до пикселя; без зума — полная точность. */
  zoom: z.coerce.number().int().min(0).max(22).optional(),
})
export type TerritoryGeometryQuery = z.infer<typeof TerritoryGeometryQuery>

/** Граница территории — GeoJSON Feature с MultiPolygon в WGS 84. */
export const TerritoryFeature = z.object({
  type: z.literal('Feature'),
  id: Uuid,
  bbox: Bbox,
  properties: z.object({ code: z.string(), level: TerritoryLevel, name: LangText }),
  geometry: z.record(z.string(), z.unknown()),
})
export type TerritoryFeature = z.infer<typeof TerritoryFeature>

const LEVEL_LIST = new RegExp(
  `^(${TERRITORY_LEVELS.join('|')})(,(${TERRITORY_LEVELS.join('|')}))*$`,
)

/**
 * Векторные тайлы границ: слой MVT на каждый уровень (имя слоя — уровень), у объекта
 * `id`, `code`, `level`, `name`; населённые пункты — точки. Без `level` — уровни по зуму.
 * `id` — свойство-строка (идентификатор объекта MVT — только целое): для feature-state
 * MapLibre источнику нужен `promoteId: 'id'`.
 */
export const TerritoryTileQuery = z.object({
  /** Уровни через запятую: `region,district`. */
  level: z.string().max(80).regex(LEVEL_LIST).optional(),
  /** Язык названий; по умолчанию — язык пользователя. */
  lang: Locale.optional(),
})
export type TerritoryTileQuery = z.infer<typeof TerritoryTileQuery>
