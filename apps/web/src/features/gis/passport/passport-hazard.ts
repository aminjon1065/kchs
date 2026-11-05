import type { Territory, TerritoryDetail } from '@kchs/contracts'
import type { MapOverlayZone } from '../map-overlays.js'

/** Обстановка по территории: самая строгая зона, чья она и сколько ещё источников. */
export interface PassportHazard {
  zone: MapOverlayZone
  /** Территория зоны: эта единица, её предок или вложенная; `null` — своя область зоны. */
  territory: Pick<Territory, 'id' | 'name'> | null
  /** Сколько ещё предупреждений задевают территорию. */
  more: number
}

/**
 * Обстановка по территории (ADR-0230): из зон наложений — те, что совпадают с этой
 * единицей, её предками или вложенными; самая строгая — на плашку, остальные —
 * «ещё N». Норма (уровень 0) плашку не поднимает, как полоса оболочки.
 */
export function hazardFor(
  unit: Pick<TerritoryDetail, 'id' | 'name' | 'path' | 'children'>,
  zones: readonly MapOverlayZone[],
): PassportHazard | null {
  const related = new Map<string, Pick<Territory, 'id' | 'name'>>([
    [unit.id, unit],
    ...unit.path.map((item) => [item.id, item] as const),
    ...unit.children.map((item) => [item.id, item] as const),
  ])
  const matching = zones.filter(
    (zone) => zone.level >= 1 && zone.territoryId !== undefined && related.has(zone.territoryId),
  )
  const [zone] = [...matching].sort((a, b) => b.level - a.level)
  if (!zone) return null
  const sources = new Set(matching.map((item) => item.objectId ?? item.title))
  return {
    zone,
    territory: zone.territoryId ? (related.get(zone.territoryId) ?? null) : null,
    more: sources.size - 1,
  }
}
