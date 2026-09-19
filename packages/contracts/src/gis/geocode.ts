import { z } from 'zod'
import { Bbox } from './layer.js'
import { LonLat, Territory } from './territory.js'

/**
 * Внутренний геокодер (07-gis-engine.md §9, ADR-0067): территории и населённые пункты
 * справочника по названию на любом языке или коду; обратное геокодирование — цепочка
 * территорий, содержащих точку.
 */
export const GeocodeQuery = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(10),
})
export type GeocodeQuery = z.infer<typeof GeocodeQuery>

/** Как найдено: код, название целиком, начало названия, начало слова, часть, опечатка. */
export const GEOCODE_MATCHES = ['code', 'name', 'prefix', 'word', 'substring', 'fuzzy'] as const
export const GeocodeMatch = z.enum(GEOCODE_MATCHES)
export type GeocodeMatch = z.infer<typeof GeocodeMatch>

export const GeocodeResult = z.object({
  territory: Territory,
  /** Путь от страны до родителя — для подписи «Навобод, Вахш, Хатлонская область». */
  path: z.array(Territory),
  /** Куда вести карту: центроид единицы (точка внутри границы). */
  center: LonLat,
  /** Экстент границы; у населённого пункта без границы — null (карта берёт центр). */
  bbox: Bbox.nullable(),
  match: GeocodeMatch,
})
export type GeocodeResult = z.infer<typeof GeocodeResult>

export const GeocodeResponse = z.object({ items: z.array(GeocodeResult) })
export type GeocodeResponse = z.infer<typeof GeocodeResponse>

export const ReverseGeocodeQuery = z.object({
  lon: z.coerce.number().min(-180).max(180),
  lat: z.coerce.number().min(-90).max(90),
})
export type ReverseGeocodeQuery = z.infer<typeof ReverseGeocodeQuery>

export const ReverseGeocodeResponse = z.object({
  /** Единицы с границей, содержащие точку, — от страны к самой мелкой (для «авто-территории»). */
  chain: z.array(Territory),
  /** Ближайший населённый пункт справочника в пределах 10 км. */
  nearest: z.object({ territory: Territory, distanceM: z.number() }).nullable(),
})
export type ReverseGeocodeResponse = z.infer<typeof ReverseGeocodeResponse>
