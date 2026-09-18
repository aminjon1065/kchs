import type { CHART_COLOR_TOKENS } from '@kchs/contracts'

/** Семантический цвет ChartSpec: accent, success, warning, danger, info, neutral, purple. */
export type ChartColorToken = (typeof CHART_COLOR_TOKENS)[number]

/**
 * Тема графика — конкретные цвета для компилятора. Спецификация хранит только
 * имена палитр и токенов; значения приходят снаружи: в браузере — из CSS-переменных
 * дизайн-системы (`--viz-*`, `--text*`, `--border*`), на сервере — из tokens.json.
 * Пакет не зависит от `@kchs/ui`.
 */
export interface ChartTheme {
  mode: 'light' | 'dark'
  fontFamily: string
  /** Категориальная палитра в фиксированном порядке (ADR-0047), 8 оттенков. */
  categorical: readonly string[]
  /** «Прочее» и приглушённые серии. */
  other: string
  /** Последовательная шкала от малого к большому. */
  sequential: readonly string[]
  /** Расходящаяся: отрицательный полюс → нейтраль → положительный полюс. */
  diverging: readonly string[]
  tokens: Readonly<Record<ChartColorToken, string>>
  /** Основной текст: значения, заголовок тултипа. */
  text: string
  /** Подписи осей, легенды, меток. */
  textSecondary: string
  /** Третичное: имена осей, подписи аннотаций. */
  textMuted: string
  /** Текст на насыщенной заливке (ячейки, сектора). */
  textInverse: string
  /** Поверхность под графиком: зазоры между заливками и кольца маркеров. */
  surface: string
  /** Фон тултипа. */
  overlay: string
  /** Линии сетки. */
  grid: string
  /** Линия оси и перекрестье. */
  axis: string
  /** Тень тултипа, CSS box-shadow. */
  shadow: string
}

// ─── Цвет ────────────────────────────────────────────────────────────────────

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const raw = m[1] as string
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw
  const n = Number.parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`
}

const linear = (c: number): number => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

/** Относительная яркость WCAG. Не hex (например, rgb()) — считаем средней. */
export function luminance(color: string): number {
  const rgb = parseHex(color)
  if (!rgb) return 0.5
  const [r, g, b] = rgb.map(linear) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Цвет текста на заливке: из двух текстовых токенов — тот, что контрастнее. */
export function textOn(fill: string, theme: ChartTheme): string {
  const dark = luminance(theme.text) < luminance(theme.textInverse) ? theme.text : theme.textInverse
  const light = dark === theme.text ? theme.textInverse : theme.text
  return contrastRatio(fill, dark) >= contrastRatio(fill, light) ? dark : light
}

/** Точка на шкале (0…1) — линейная интерполяция между соседними шагами. */
export function rampColor(ramp: readonly string[], t: number): string {
  if (ramp.length === 0) return '#808080'
  if (ramp.length === 1) return ramp[0] as string
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (ramp.length - 1)
  const i = Math.min(ramp.length - 2, Math.floor(x))
  const a = parseHex(ramp[i] as string)
  const b = parseHex(ramp[i + 1] as string)
  if (!a || !b) return ramp[Math.round(x)] as string
  const f = x - i
  return toHex([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f])
}

/** Цвет с прозрачностью для ECharts (rgba), не hex — оставляем как есть. */
export function withAlpha(color: string, alpha: number): string {
  const rgb = parseHex(color)
  if (!rgb) return color
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`
}
