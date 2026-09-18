/**
 * Проверка контраста WCAG 2.2 AA для текстовых токенов (03-ui/02-design-system.md).
 * Запускается в CI. Каждый цвет, которым пишется мелкий текст, должен давать
 * не меньше 4,5:1 на всех фонах, где он встречается: поверхностях, подсветке
 * строк и собственной «мягкой» подложке (бейджи, сообщения). То же проверяет axe
 * на историях Storybook (`pnpm --filter @kchs/ui test:visual`).
 */
import tokens from '../src/tokens/tokens.json' with { type: 'json' }

type Theme = 'light' | 'dark'

function srgb(channel: number): number {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const value = hex.replace('#', '')
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b)
}

function ratio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const neutral = tokens.color.neutral as Record<string, { light: string; dark: string }>
const accent = tokens.color.accent as Record<string, { light: string; dark: string }>
const semantic = tokens.color.semantic as Record<string, { light: string; dark: string }>

const TEXT_AA = 4.5

interface Check {
  name: string
  fg: string
  bg: string
  min: number
}

let failed = 0

for (const theme of ['light', 'dark'] as Theme[]) {
  const color = (group: Record<string, { light: string; dark: string }>, key: string) =>
    group[key]![theme]
  const surfaces = ['bg-canvas', 'bg-surface', 'bg-surface-2']
  const checks: Check[] = []

  // Нейтральный текст — на поверхностях; третичный ещё и на подсветке строк и выделения
  for (const text of ['text', 'text-secondary', 'text-muted']) {
    const backgrounds = text === 'text-muted' ? [...surfaces, 'bg-surface-3'] : surfaces
    for (const surface of backgrounds) {
      checks.push({
        name: `${text} на ${surface}`,
        fg: color(neutral, text),
        bg: color(neutral, surface),
        min: TEXT_AA,
      })
    }
  }
  checks.push({
    name: 'text-muted на accent-subtle (выбранный пункт палитры)',
    fg: color(neutral, 'text-muted'),
    bg: color(accent, 'accent-subtle'),
    min: TEXT_AA,
  })

  // Акцент и семантика как текст: ссылки, дельты показателей, ошибки полей, бейджи
  const textColors: Array<[string, Record<string, { light: string; dark: string }>, string]> = [
    ['accent', accent, 'accent-subtle'],
    ['success', semantic, 'success-subtle'],
    ['warning', semantic, 'warning-subtle'],
    ['danger', semantic, 'danger-subtle'],
    ['purple', semantic, 'purple-subtle'],
    ['info', semantic, 'info-subtle'],
  ]
  for (const [name, group, subtle] of textColors) {
    for (const surface of surfaces) {
      checks.push({
        name: `${name} на ${surface}`,
        fg: color(group, name),
        bg: color(neutral, surface),
        min: TEXT_AA,
      })
    }
    checks.push({
      name: `${name} на ${subtle}`,
      fg: color(group, name),
      bg: color(group, subtle),
      min: TEXT_AA,
    })
  }

  // Текст на заливках: основная и «опасная» кнопки
  checks.push(
    {
      name: 'accent-fg на accent',
      fg: color(accent, 'accent-fg'),
      bg: color(accent, 'accent'),
      min: TEXT_AA,
    },
    {
      name: 'danger-fg на danger',
      fg: color(semantic, 'danger-fg'),
      bg: color(semantic, 'danger'),
      min: TEXT_AA,
    },
  )

  process.stdout.write(`\n${theme === 'light' ? 'Светлая' : 'Тёмная'} тема\n`)
  for (const check of checks) {
    const value = ratio(check.fg, check.bg)
    const ok = value >= check.min
    if (!ok) failed += 1
    process.stdout.write(
      `  ${ok ? '✓' : '✗'} ${check.name}: ${value.toFixed(2)}:1 (нужно ≥ ${check.min})\n`,
    )
  }
}

// ─── Палитра графиков (ADR-0049) ─────────────────────────────────────────────
// Различимость считается, а не оценивается на глаз: расстояние в OKLab (×100)
// после симуляции протанопии и дейтеранопии (Machado, Oliveira, Fernandes 2009,
// полная тяжесть). Соседние оттенки — не меньше 8, при обычном зрении — не меньше
// 15; первые три (графики «все со всеми», например точечные) — все пары.
// Шаги последовательной шкалы различаются по светлоте OKLab не меньше чем на 0,06.

const CVD: Record<'protan' | 'deutan', number[][]> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
}

function linearRgb(hex: string): number[] {
  const value = hex.replace('#', '')
  return [0, 2, 4].map((i) => srgb(Number.parseInt(value.slice(i, i + 2), 16)))
}

function oklab([r, g, b]: number[]): number[] {
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!)
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!)
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function simulate(hex: string, kind?: keyof typeof CVD): number[] {
  const rgb = linearRgb(hex)
  if (!kind) return rgb
  return CVD[kind].map((row) =>
    Math.min(1, Math.max(0, row[0]! * rgb[0]! + row[1]! * rgb[1]! + row[2]! * rgb[2]!)),
  )
}

function deltaE(a: string, b: string, kind?: keyof typeof CVD): number {
  const [l1, a1, b1] = oklab(simulate(a, kind))
  const [l2, a2, b2] = oklab(simulate(b, kind))
  return 100 * Math.hypot(l1! - l2!, a1! - a2!, b1! - b2!)
}

const viz = tokens.color.viz
for (const theme of ['light', 'dark'] as Theme[]) {
  const palette = viz.categorical[theme]
  const pairs: Array<[number, number]> = []
  for (let i = 0; i < palette.length - 1; i += 1) pairs.push([i, i + 1])
  pairs.push([0, 2])
  let worstCvd = Number.POSITIVE_INFINITY
  let worstNormal = Number.POSITIVE_INFINITY
  let worstPair = ''
  for (const [i, j] of pairs) {
    const a = palette[i]!
    const b = palette[j]!
    const cvd = Math.min(deltaE(a, b, 'protan'), deltaE(a, b, 'deutan'))
    if (cvd < worstCvd) worstPair = `${a}/${b}`
    worstCvd = Math.min(worstCvd, cvd)
    worstNormal = Math.min(worstNormal, deltaE(a, b))
  }
  const ramp = viz.sequential[theme]
  const lightness = ramp.map((hex) => oklab(linearRgb(hex))[0]!)
  const minStep = Math.min(...lightness.slice(1).map((l, i) => Math.abs(l - lightness[i]!)))
  const vizChecks: Array<[string, number, number]> = [
    [`палитра графиков при цветослепоте (худшая пара ${worstPair}), ΔE`, worstCvd, 8],
    ['палитра графиков при обычном зрении, ΔE', worstNormal, 15],
    ['шаги последовательной шкалы по светлоте, ΔL×100', minStep * 100, 6],
  ]
  process.stdout.write(`\nГрафики, ${theme === 'light' ? 'светлая' : 'тёмная'} тема\n`)
  for (const [name, value, min] of vizChecks) {
    const ok = value >= min
    if (!ok) failed += 1
    process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}: ${value.toFixed(1)} (нужно ≥ ${min})\n`)
  }
}

process.stdout.write(failed === 0 ? '\nКонтраст в норме\n' : `\nНарушений контраста: ${failed}\n`)
process.exit(failed === 0 ? 0 : 1)
