import type { MapTheme } from '@kchs/map-style'
import type { MapLayerSpecification } from '@kchs/ui'

/**
 * Лёгкая часть моста deck.gl (ADR-0110): что можно отдать deck.gl и каким
 * цветом подсвечивать выделение. Здесь нет вычислителя выражений стиля —
 * он приходит вместе с deck.gl отдельным куском сборки (`deck-style.ts`).
 */

/** Цвет deck.gl: [r, g, b, a] в диапазоне 0…255. */
export type DeckColor = [number, number, number, number]

/** Свойства объекта тайла — то, что видит аксессор. */
export type FeatureProps = Record<string, unknown>

/** Роли скомпилированного стиля, которые умеет рисовать deck.gl. */
const SUPPORTED_ROLES = new Set(['fill', 'outline', 'line', 'point'])
/** Роли, из-за которых слой остаётся в MapLibre (кластеры, подписи, тепловая карта). */
const MAPLIBRE_ONLY_ROLES = new Set(['cluster', 'cluster-count', 'label', 'heatmap'])

export function roleOf(layer: MapLayerSpecification): string {
  const metadata = (layer as { metadata?: Record<string, unknown> }).metadata
  const role = metadata?.['kchs:role']
  return typeof role === 'string' ? role : ''
}

/**
 * Можно ли отдать слой в deck.gl: только простые роли (заливка, линия, точка).
 * Кластеры, подписи и тепловая карта остаются в MapLibre — deck их не рисует.
 */
export function deckDrawable(layers: readonly MapLayerSpecification[]): boolean {
  if (layers.length === 0) return false
  if (layers.some((layer) => MAPLIBRE_ONLY_ROLES.has(roleOf(layer)))) return false
  if (!layers.some((layer) => SUPPORTED_ROLES.has(roleOf(layer)))) return false
  // Значки и фигуры точек рисует symbol-слой — deck.gl о них не знает
  return !layers.some((layer) => roleOf(layer) === 'point' && layer.type === 'symbol')
}

/** Цвет выделения deck.gl — тот же акцент темы, что у слоёв подсветки MapLibre. */
export function deckSelectionColor(theme: MapTheme | null): DeckColor {
  const hex = /^#([0-9a-f]{6})$/i.exec(theme?.tokens.accent ?? '')
  if (!hex?.[1]) return [37, 99, 235, 255]
  const value = Number.parseInt(hex[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 255]
}
