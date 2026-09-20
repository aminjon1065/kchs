import type { MapLayerSpecification } from '@kchs/ui'
import { createExpression, latest } from '@maplibre/maplibre-gl-style-spec'
import { type DeckColor, type FeatureProps, roleOf } from './deck-roles.js'

/**
 * Мост «скомпилированный стиль MapLibre → аксессоры deck.gl» (ADR-0110).
 * Этот модуль грузится вместе с deck.gl: он тянет вычислитель выражений
 * спецификации и в основной бандл не попадает.
 *
 * Стиль слоя один: его пишет компилятор `packages/map-style`. Чтобы deck.gl
 * рисовал ровно то же, что MapLibre, выражения стиля вычисляются настоящим
 * вычислителем спецификации (`@maplibre/maplibre-gl-style-spec`), а не
 * переписываются во второй раз.
 */

type Evaluate<T> = (properties: FeatureProps, zoom: number) => T

export interface DeckPaint {
  /** Что рисуем: точки, линии или полигоны с обводкой. */
  kind: 'circle' | 'line' | 'fill'
  minzoom: number
  maxzoom: number
  /** Показывать объект (фильтр слоя стиля). */
  visible: Evaluate<boolean>
  fillColor: Evaluate<DeckColor>
  lineColor: Evaluate<DeckColor>
  /** Радиус точки, пикселей. */
  radius: Evaluate<number>
  /** Толщина линии или обводки, пикселей. */
  lineWidth: Evaluate<number>
}

/** Цвет вычислителя (0…1 по каналам) → цвет deck.gl с учётом прозрачности. */
function toDeckColor(value: unknown, opacity: number): DeckColor {
  const color = value as { r?: number; g?: number; b?: number; a?: number } | undefined
  if (!color || typeof color.r !== 'number') return [0, 0, 0, Math.round(255 * opacity)]
  // Цвет спецификации premultiplied: делим на альфу, иначе прозрачное тускнеет дважды
  const alpha = typeof color.a === 'number' ? color.a : 1
  const channel = (raw: number) =>
    Math.round(Math.min(255, Math.max(0, (raw / (alpha || 1)) * 255)))
  return [
    channel(color.r),
    channel(color.g ?? 0),
    channel(color.b ?? 0),
    Math.round(255 * alpha * opacity),
  ]
}

type PropertySpec = Parameters<typeof createExpression>[2]

function specOf(property: string): PropertySpec {
  const reference = latest as unknown as Record<string, Record<string, unknown>>
  for (const group of ['paint_circle', 'paint_fill', 'paint_line']) {
    const found = reference[group]?.[property]
    if (found) return found as PropertySpec
  }
  return null
}

/** Вычислитель свойства стиля; выражение не разобралось — значение по умолчанию. */
function evaluator<T>(
  value: unknown,
  property: string,
  fallback: T,
  map: (raw: unknown) => T,
): Evaluate<T> {
  if (value === undefined) return () => fallback
  const compiled = createExpression(value, property, specOf(property))
  if (compiled.result !== 'success') return () => fallback
  const expression = compiled.value
  return (properties, zoom) => {
    try {
      return map(expression.evaluate({ zoom }, { type: 1, properties } as never))
    } catch {
      return fallback
    }
  }
}

/** Условие показа объекта: `filter` слоя MapLibre. */
function filterOf(filter: unknown): Evaluate<boolean> {
  if (filter === undefined) return () => true
  const compiled = createExpression(filter, 'filter', null)
  if (compiled.result !== 'success') return () => true
  const expression = compiled.value
  return (properties, zoom) => {
    try {
      return expression.evaluate({ zoom }, { type: 1, properties } as never) === true
    } catch {
      return true
    }
  }
}

function paintOf(layer: MapLayerSpecification): Record<string, unknown> {
  return ((layer as { paint?: Record<string, unknown> }).paint ?? {}) as Record<string, unknown>
}

/**
 * Краска deck.gl из скомпилированных слоёв MapLibre одного слоя карты.
 * `opacity` слоя карты уже учтён компилятором в `*-opacity`.
 */
export function deckPaint(layers: readonly MapLayerSpecification[]): DeckPaint | null {
  const circle = layers.find((layer) => layer.type === 'circle' && roleOf(layer) === 'point')
  const fill = layers.find((layer) => layer.type === 'fill')
  const line = layers.find(
    (layer) => layer.type === 'line' && ['line', 'outline'].includes(roleOf(layer)),
  )
  const primary = circle ?? fill ?? line
  if (!primary) return null

  const zoom = primary as { minzoom?: number; maxzoom?: number }
  const base = {
    minzoom: zoom.minzoom ?? 0,
    maxzoom: zoom.maxzoom ?? 24,
    visible: filterOf((primary as { filter?: unknown }).filter),
  }

  if (circle) {
    const paint = paintOf(circle)
    const opacity = numberOf(paint['circle-opacity'], 1)
    const strokeOpacity = numberOf(paint['circle-stroke-opacity'], 1)
    return {
      ...base,
      kind: 'circle',
      fillColor: evaluator(paint['circle-color'], 'circle-color', [0, 0, 0, 255], (raw) =>
        toDeckColor(raw, opacity),
      ),
      lineColor: evaluator(
        paint['circle-stroke-color'],
        'circle-stroke-color',
        [0, 0, 0, 0],
        (raw) => toDeckColor(raw, strokeOpacity),
      ),
      radius: evaluator(paint['circle-radius'], 'circle-radius', 4, (raw) => Number(raw) || 4),
      lineWidth: evaluator(
        paint['circle-stroke-width'],
        'circle-stroke-width',
        0,
        (raw) => Number(raw) || 0,
      ),
    }
  }

  if (fill) {
    const paint = paintOf(fill)
    const opacity = numberOf(paint['fill-opacity'], 1)
    const outline = line ? paintOf(line) : {}
    const outlineOpacity = numberOf(outline['line-opacity'], 1)
    return {
      ...base,
      kind: 'fill',
      fillColor: evaluator(paint['fill-color'], 'fill-color', [0, 0, 0, 255], (raw) =>
        toDeckColor(raw, opacity),
      ),
      lineColor: evaluator(outline['line-color'], 'line-color', [0, 0, 0, 0], (raw) =>
        toDeckColor(raw, outlineOpacity),
      ),
      radius: () => 0,
      lineWidth: evaluator(outline['line-width'], 'line-width', 1, (raw) => Number(raw) || 1),
    }
  }

  const paint = paintOf(line as MapLayerSpecification)
  const opacity = numberOf(paint['line-opacity'], 1)
  return {
    ...base,
    kind: 'line',
    fillColor: () => [0, 0, 0, 0],
    lineColor: evaluator(paint['line-color'], 'line-color', [0, 0, 0, 255], (raw) =>
      toDeckColor(raw, opacity),
    ),
    radius: () => 0,
    lineWidth: evaluator(paint['line-width'], 'line-width', 1, (raw) => Number(raw) || 1),
  }
}

/** Постоянное число из свойства краски; выражение — 1 (прозрачность уже в цвете). */
function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback
}
