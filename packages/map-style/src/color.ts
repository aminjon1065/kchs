/**
 * Цвет для компилятора стилей: разбор hex, OKLab (интерполяция шкал, производные
 * цвета обводки), контраст текста. Шкалы интерполируются в OKLab — шаги светлоты
 * между опорными цветами остаются ровными (ADR-0065).
 */

type Rgb = [number, number, number]
type Lab = [number, number, number]

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

export function isHex(color: string): boolean {
  return HEX.test(color.trim())
}

/** #rrggbb или короткий #rgb (так значения переменных отдаёт минифицированный CSS). */
function parseHex(hex: string): Rgb {
  const match = HEX.exec(hex.trim())
  if (!match) throw new Error(`Цвет не в формате #rrggbb: ${hex}`)
  const raw = match[1] as string
  const full = raw.length === 3 ? [...raw].map((c) => c + c).join('') : raw
  const n = Number.parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex(rgb: Rgb): string {
  return `#${rgb
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`
}

const toLinear = (c: number): number => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

const fromLinear = (c: number): number => {
  const v = Math.min(1, Math.max(0, c))
  return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)
}

function toOklab(hex: string): Lab {
  const [r, g, b] = parseHex(hex).map(toLinear) as Rgb
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function fromOklab([L, a, b]: Lab): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return toHex([
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ])
}

/** Смешение двух цветов в OKLab: t = 0 — первый, 1 — второй. */
export function mix(from: string, to: string, t: number): string {
  if (t <= 0) return toHex(parseHex(from))
  if (t >= 1) return toHex(parseHex(to))
  const a = toOklab(from)
  const b = toOklab(to)
  return fromOklab([0, 1, 2].map((i) => a[i]! + (b[i]! - a[i]!) * t) as Lab)
}

/** Цвет шкалы в точке t ∈ [0, 1]: кусочно-линейно между опорными цветами. */
export function rampAt(anchors: readonly string[], t: number): string {
  if (anchors.length === 0) throw new Error('Пустая шкала')
  if (anchors.length === 1) return toHex(parseHex(anchors[0] as string))
  const position = Math.min(1, Math.max(0, t)) * (anchors.length - 1)
  const index = Math.min(anchors.length - 2, Math.floor(position))
  return mix(anchors[index] as string, anchors[index + 1] as string, position - index)
}

/**
 * n цветов шкалы, равномерно от первого опорного до последнего. У расходящейся
 * шкалы с нечётным n средний класс — ровно нейтраль.
 */
export function sampleRamp(anchors: readonly string[], n: number): string[] {
  if (n <= 0) return []
  if (n === 1) return [rampAt(anchors, 0.5)]
  return Array.from({ length: n }, (_, i) => rampAt(anchors, i / (n - 1)))
}

/** Сдвиг светлоты OKLab: обводка «auto» темнее заливки в светлой теме и светлее в тёмной. */
export function shiftLightness(hex: string, delta: number): string {
  const [L, a, b] = toOklab(hex)
  return fromOklab([Math.min(0.98, Math.max(0.12, L + delta)), a, b])
}

function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map(toLinear) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Из двух цветов текста — более контрастный на фоне (число в кружке кластера). */
export function readableOn(background: string, first: string, second: string): string {
  return contrast(background, first) >= contrast(background, second) ? first : second
}

/** hex → rgba() с прозрачностью: нулевой край тепловой карты. */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Нормализованный hex (верхний регистр) — для стабильных снимков. */
export function normalizeHex(hex: string): string {
  return toHex(parseHex(hex))
}
