import type { StylePalette, StylePaletteName } from '@kchs/contracts'
import { isHex, normalizeHex, rampAt, sampleRamp, shiftLightness } from './color.js'
import {
  DIVERGING_RAMPS,
  type DivergingRamp,
  MAP_COLOR_TOKENS,
  type MapColorToken,
  type MapTheme,
  SEQUENTIAL_RAMPS,
  type SequentialRamp,
} from './model.js'

const isSequential = (name: string): name is SequentialRamp =>
  (SEQUENTIAL_RAMPS as readonly string[]).includes(name)
const isDiverging = (name: string): name is DivergingRamp =>
  (DIVERGING_RAMPS as readonly string[]).includes(name)
const isToken = (name: string): name is MapColorToken =>
  (MAP_COLOR_TOKENS as readonly string[]).includes(name)

/**
 * Опорные цвета палитры в теме. `status` — шкала «хорошо → плохо»
 * (success → warning → danger), `categorical` — палитра графиков по порядку.
 */
export function paletteAnchors(theme: MapTheme, name: StylePaletteName): readonly string[] {
  if (name === 'categorical') return theme.categorical
  if (name === 'status') return [theme.tokens.success, theme.tokens.warning, theme.tokens.danger]
  if (isDiverging(name)) return theme.diverging[name]
  return theme.sequential[name]
}

/**
 * n цветов палитры для классов (3–9): шкалы — равномерно в OKLab от первого шага
 * до последнего, категориальная — первые n по порядку (девятый — «прочее»).
 * `reverse` переворачивает порядок: большему значению — светлый край.
 */
export function paletteColors(
  theme: MapTheme,
  palette: StylePalette | StylePaletteName,
  n: number,
): string[] {
  const { name, reverse } =
    typeof palette === 'string' ? { name: palette, reverse: false } : palette
  let colors: string[]
  if (name === 'categorical') {
    colors = Array.from({ length: n }, (_, i) =>
      normalizeHex(i < theme.categorical.length ? (theme.categorical[i] as string) : theme.other),
    )
  } else {
    colors = sampleRamp(paletteAnchors(theme, name), n)
  }
  return reverse ? colors.reverse() : colors
}

/** Один цвет палитры: для размера по классам, запасной отрисовки и кластеров. */
export function paletteColor(theme: MapTheme, palette: StylePalette): string {
  if (palette.name === 'categorical') return normalizeHex(theme.categorical[0] as string)
  const t = palette.reverse ? 0.25 : 0.75
  return rampAt(paletteAnchors(theme, palette.name), t)
}

export interface ResolvedColor {
  color: string
  /** false — токен неизвестен, взят первый цвет палитры. */
  known: boolean
}

/**
 * Цвет стиля (`StyleColor`) → hex темы:
 * `#rrggbb` — как есть; `categorical.N` — палитра графиков (по кругу из 8);
 * `<шкала>.N` — шаг шкалы 1…7 (`blue.3`, `red-blue.1`), без номера — пятый;
 * `status.N` — success, warning, danger; семантические `accent`, `success`,
 * `warning`, `danger`, `info`, `neutral`, `purple`; `other` — «прочее».
 * `auto` решает вызывающий (производный цвет) — здесь это ошибка токена.
 */
export function resolveColor(color: string, theme: MapTheme): ResolvedColor {
  const value = color.trim()
  if (isHex(value)) return { color: normalizeHex(value), known: true }
  const [name = '', index] = value.split('.')
  const n = index === undefined ? null : Number(index)
  if (name === 'categorical') {
    const list = theme.categorical
    const i = n === null ? 0 : (((n - 1) % list.length) + list.length) % list.length
    return { color: normalizeHex(list[i] as string), known: true }
  }
  if (name === 'status') {
    const list = paletteAnchors(theme, 'status')
    const i = Math.min(list.length, Math.max(1, n ?? 1)) - 1
    return { color: normalizeHex(list[i] as string), known: true }
  }
  if (isSequential(name) || isDiverging(name)) {
    const list = isSequential(name) ? theme.sequential[name] : theme.diverging[name]
    const i = Math.min(list.length, Math.max(1, n ?? 5)) - 1
    return { color: normalizeHex(list[i] as string), known: true }
  }
  if (n === null && isToken(name)) return { color: normalizeHex(theme.tokens[name]), known: true }
  if (n === null && name === 'other') return { color: normalizeHex(theme.other), known: true }
  return { color: normalizeHex(theme.categorical[0] as string), known: false }
}

/**
 * Производный цвет («auto»): обводка полигона и кольцо точки — того же оттенка,
 * темнее заливки в светлой теме и светлее в тёмной.
 */
export function deriveOutline(color: string, theme: MapTheme): string {
  return shiftLightness(color, theme.mode === 'light' ? -0.16 : 0.14)
}
