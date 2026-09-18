import { z } from 'zod'
import { LangText, Uuid } from '../common/primitives.js'

/**
 * Территории — сквозной справочник административного деления (07-gis-engine.md
 * §11, ADR-0057): объект реестра типа `territory`, иерархия с замыканием.
 * Уровни — от страны до населённого пункта; фаза 1 загружает страну, регионы и районы.
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
})
export type TerritoryDetail = z.infer<typeof TerritoryDetail>
