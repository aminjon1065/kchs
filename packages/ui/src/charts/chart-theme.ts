import type { ChartTheme } from '@kchs/chart-spec'
import { useEffect, useState } from 'react'

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

/** `rgb(r, g, b)` вычисленного стиля → hex: тема графика работает с hex. */
function toHex(color: string): string {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color)
  if (!m) return color
  return `#${[m[1], m[2], m[3]]
    .map((v) => Number(v).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`
}

/** Фон, на котором лежит график: ближайший непрозрачный предок (карточка, холст). */
function backgroundOf(element: HTMLElement): string | null {
  let node: HTMLElement | null = element
  while (node) {
    const color = getComputedStyle(node).backgroundColor
    if (color && color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color)) return toHex(color)
    node = node.parentElement
  }
  return null
}

/**
 * Тема графика из CSS-переменных дизайн-системы (ADR-0047): палитра `--viz-*`,
 * текст, линии, поверхности. Зазоры между заливками и кольца маркеров — цветом
 * фактического фона под графиком.
 */
export function readChartTheme(element: HTMLElement): ChartTheme {
  const css = getComputedStyle(element)
  const v = (name: string) => css.getPropertyValue(name).trim()
  const surface = backgroundOf(element) ?? v('--bg-surface')
  return {
    mode: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
    fontFamily: css.fontFamily,
    categorical: range(8).map((i) => v(`--viz-cat-${i}`)),
    other: v('--viz-other'),
    sequential: range(6).map((i) => v(`--viz-seq-${i}`)),
    diverging: range(7).map((i) => v(`--viz-div-${i}`)),
    tokens: {
      accent: v('--accent'),
      success: v('--success'),
      warning: v('--warning'),
      danger: v('--danger'),
      info: v('--info'),
      neutral: v('--text-muted'),
      purple: v('--purple'),
    },
    text: v('--text'),
    textSecondary: v('--text-secondary'),
    textMuted: v('--text-muted'),
    textInverse: v('--text-inverse'),
    surface,
    overlay: v('--bg-overlay'),
    grid: v('--border'),
    axis: v('--border-strong'),
    shadow: v('--elevation-md'),
  }
}

/**
 * Тема графика для элемента; пересчитывается при смене темы приложения
 * (`data-theme` на <html>) и системной темы.
 */
export function useChartTheme(element: HTMLElement | null): ChartTheme | null {
  const [theme, setTheme] = useState<ChartTheme | null>(null)
  useEffect(() => {
    if (!element) return
    const update = () => setTheme(readChartTheme(element))
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
