import type { HazardLevel } from '@kchs/ui'
import type { ComponentType } from 'react'

/** Зона наложения: геометрия GeoJSON и уровень шкалы обстановки (ADR-0230). */
export interface MapOverlayZone {
  geometry: { type: string; coordinates: unknown }
  level: HazardLevel
  title: string
  /** Территория справочника, если зона — её граница: паспорт ищет обстановку по ней. */
  territoryId?: string
  /** Объект-источник зоны (предупреждение) — его открывает паспорт. */
  objectId?: string
  /** Тип объекта-источника для вкладки (`warning`). */
  objectType?: string
}

/** Данные наложения: подпись строки в панели слоёв и зоны. */
export interface MapOverlayData {
  label: string
  zones: readonly MapOverlayZone[]
}

/**
 * Наложение другой фичи на карты gis (ADR-0230): зоны действующих предупреждений и
 * подобное — не слой реестра, а данные своего модуля. Поставщик — ленивый компонент без
 * разметки: сам берёт данные своими запросами и отдаёт их карте через `onData`
 * (`null` — данных нет: экран выключен, нет доступа, запрос не прошёл). Карта знает
 * только этот договор, а не модуль-поставщик.
 */
export interface MapOverlay {
  id: string
  Feed: ComponentType<{ onData: (data: MapOverlayData | null) => void }>
}

const overlays: MapOverlay[] = []

/** Регистрация — в точке сборки модулей (`app/modules.tsx`), до первой отрисовки карт. */
export function registerMapOverlay(overlay: MapOverlay): void {
  if (!overlays.some((item) => item.id === overlay.id)) overlays.push(overlay)
}

export function mapOverlays(): readonly MapOverlay[] {
  return overlays
}
