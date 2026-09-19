import {
  DIVERGING_RAMPS,
  MAP_COLOR_TOKENS,
  type MapColorToken,
  type MapTheme,
  SEQUENTIAL_RAMPS,
} from '@kchs/map-style'
import { useEffect, useState } from 'react'

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

/** CSS-переменная семантического цвета: `neutral` — третичный текст, как у графиков. */
const TOKEN_VARIABLES: Record<MapColorToken, string> = {
  accent: '--accent',
  success: '--success',
  warning: '--warning',
  danger: '--danger',
  info: '--info',
  neutral: '--text-muted',
  purple: '--purple',
}

/**
 * Цвет переменной → #RRGGBB: компилятор стиля работает с hex, а минифицированный
 * CSS отдаёт короткую запись (`#fff`), вычисленный стиль — `rgb(r, g, b)`.
 */
function toHex(color: string): string {
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color)
  if (rgb) {
    return `#${[rgb[1], rgb[2], rgb[3]]
      .map((v) => Number(v).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()}`
  }
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color)
  if (short)
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase()
  return color.toUpperCase()
}

function record<K extends string, V>(keys: readonly K[], value: (key: K) => V): Record<K, V> {
  return Object.fromEntries(keys.map((key) => [key, value(key)])) as Record<K, V>
}

function isDark(hex: string): boolean {
  const n = Number.parseInt(hex.slice(1), 16)
  if (Number.isNaN(n)) return false
  const channel = (v: number) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const luminance =
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  return luminance < 0.2
}

/**
 * Тема карты из CSS-переменных дизайн-системы (ADR-0065): шкалы `--seq-*` и
 * `--div-*` (свои шаги для каждой темы), палитра графиков `--viz-cat-*`,
 * `--viz-other`, семантические цвета, текст и поверхность для подписей.
 * Светлая или тёмная — по яркости поверхности: так же работает и системная тема.
 */
export function readMapTheme(element: HTMLElement): MapTheme {
  const css = getComputedStyle(element)
  const v = (name: string) => toHex(css.getPropertyValue(name).trim())
  const ramp = (prefix: string, name: string) => range(7).map((i) => v(`--${prefix}-${name}-${i}`))
  const surface = v('--bg-surface')
  return {
    mode: isDark(surface) ? 'dark' : 'light',
    categorical: range(8).map((i) => v(`--viz-cat-${i}`)),
    other: v('--viz-other'),
    sequential: record(SEQUENTIAL_RAMPS, (name) => ramp('seq', name)),
    diverging: record(DIVERGING_RAMPS, (name) => ramp('div', name)),
    tokens: record(MAP_COLOR_TOKENS, (token) => v(TOKEN_VARIABLES[token])),
    text: v('--text'),
    surface,
  }
}

/**
 * Тема карты для элемента; пересчитывается при смене темы приложения
 * (`data-theme` на <html>) и системной темы.
 */
export function useMapTheme(element: HTMLElement | null): MapTheme | null {
  const [theme, setTheme] = useState<MapTheme | null>(null)
  useEffect(() => {
    if (!element) return
    const update = () => setTheme(readMapTheme(element))
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', update)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', update)
    }
  }, [element])
  return theme
}
