/**
 * tokens.json → tokens.css (CSS-переменные для светлой и тёмной темы,
 * плотностей и движения). Имена переменных стабильны — на них опирается
 * Tailwind-тема и правило «никаких ad-hoc значений».
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tokens from '../src/tokens/tokens.json' with { type: 'json' }

type Pair = { light: string; dark: string }

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.resolve(here, '../src/tokens/tokens.css')

const lines: string[] = []
const light: string[] = []
const dark: string[] = []

function pairs(group: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(group)) {
    const pair = value as Partial<Pair>
    if (typeof pair?.light !== 'string') continue
    light.push(`  --${name}: ${pair.light};`)
    dark.push(`  --${name}: ${pair.dark ?? pair.light};`)
  }
}

pairs(tokens.color.neutral as Record<string, unknown>)
pairs(tokens.color.accent as Record<string, unknown>)
pairs(tokens.color.semantic as Record<string, unknown>)

// Палитры данных
tokens.color.categorical.light.forEach((value, index) => {
  light.push(`  --chart-${index + 1}: ${value};`)
  dark.push(`  --chart-${index + 1}: ${tokens.color.categorical.dark[index]};`)
})
for (const [name, ramp] of Object.entries(tokens.color.sequential)) {
  ;(ramp as string[]).forEach((value, index) => {
    light.push(`  --seq-${name}-${index + 1}: ${value};`)
    dark.push(`  --seq-${name}-${index + 1}: ${value};`)
  })
}
;(tokens.color.diverging['red-blue'] as string[]).forEach((value, index) => {
  light.push(`  --div-red-blue-${index + 1}: ${value};`)
  dark.push(`  --div-red-blue-${index + 1}: ${value};`)
})

// Палитра графиков (ADR-0049): свои шаги для каждой темы
const viz = tokens.color.viz
viz.categorical.light.forEach((value, index) => {
  light.push(`  --viz-cat-${index + 1}: ${value};`)
  dark.push(`  --viz-cat-${index + 1}: ${viz.categorical.dark[index]};`)
})
light.push(`  --viz-other: ${viz.other.light};`)
dark.push(`  --viz-other: ${viz.other.dark};`)
viz.sequential.light.forEach((value, index) => {
  light.push(`  --viz-seq-${index + 1}: ${value};`)
  dark.push(`  --viz-seq-${index + 1}: ${viz.sequential.dark[index]};`)
})
viz.diverging.light.forEach((value, index) => {
  light.push(`  --viz-div-${index + 1}: ${value};`)
  dark.push(`  --viz-div-${index + 1}: ${viz.diverging.dark[index]};`)
})

for (const [name, value] of Object.entries(tokens.shadow)) {
  const pair = value as Pair
  light.push(`  --elevation-${name}: ${pair.light};`)
  dark.push(`  --elevation-${name}: ${pair.dark};`)
}

lines.push('/* Сгенерировано из tokens.json — не редактировать вручную. */')
lines.push('/* pnpm --filter @kchs/ui tokens */')
lines.push('')
lines.push(':root {')
lines.push(...light)
lines.push('')
for (const [name, value] of Object.entries(tokens.motion.duration)) {
  lines.push(`  --duration-${name}: ${value};`)
}
for (const [name, value] of Object.entries(tokens.motion.easing)) {
  lines.push(`  --ease-${name}: ${value};`)
}
lines.push('')
for (const [name, value] of Object.entries(tokens.layer)) {
  lines.push(`  --z-${name}: ${value};`)
}
lines.push('')
for (const [name, value] of Object.entries(tokens.layout)) {
  lines.push(`  --${name}: ${value};`)
}
lines.push('')
lines.push('  /* Плотность по умолчанию — комфортная */')
for (const [name, value] of Object.entries(tokens.density.comfortable)) {
  lines.push(`  --${name}: ${value};`)
}
lines.push('}')
lines.push('')
lines.push('[data-density="compact"] {')
for (const [name, value] of Object.entries(tokens.density.compact)) {
  lines.push(`  --${name}: ${value};`)
}
lines.push('}')
lines.push('')
lines.push('/* Тёмная тема — отдельно выверенные поверхности, не инверсия */')
lines.push('[data-theme="dark"] {')
lines.push(...dark)
lines.push('}')
lines.push('')
lines.push('@media (prefers-color-scheme: dark) {')
lines.push('  :root:not([data-theme="light"]) {')
lines.push(...dark.map((l) => `  ${l}`))
lines.push('  }')
lines.push('}')
lines.push('')

writeFileSync(out, `${lines.join('\n')}`, 'utf8')

// ── theme.css: отображение токенов в пространства имён Tailwind 4 ───────────
const theme: string[] = []
theme.push('/* Сгенерировано из tokens.json — не редактировать вручную. */')
theme.push('/* Отображение токенов kchs в утилиты Tailwind 4. */')
theme.push('')
theme.push('@theme inline {')
theme.push('  /* Цвет: значения берутся из CSS-переменных, поэтому смена темы мгновенна */')
const colorMap: Record<string, string> = {
  canvas: 'bg-canvas',
  surface: 'bg-surface',
  'surface-2': 'bg-surface-2',
  'surface-3': 'bg-surface-3',
  overlay: 'bg-overlay',
  line: 'border',
  'line-strong': 'border-strong',
  fg: 'text',
  'fg-secondary': 'text-secondary',
  'fg-muted': 'text-muted',
  'fg-inverse': 'text-inverse',
  accent: 'accent',
  'accent-hover': 'accent-hover',
  'accent-subtle': 'accent-subtle',
  'accent-fg': 'accent-fg',
  success: 'success',
  'success-subtle': 'success-subtle',
  warning: 'warning',
  'warning-subtle': 'warning-subtle',
  danger: 'danger',
  'danger-subtle': 'danger-subtle',
  'danger-fg': 'danger-fg',
  info: 'info',
  'info-subtle': 'info-subtle',
  purple: 'purple',
  'purple-subtle': 'purple-subtle',
}
for (const [utility, variable] of Object.entries(colorMap)) {
  theme.push(`  --color-${utility}: var(--${variable});`)
}
tokens.color.categorical.light.forEach((_, index) => {
  theme.push(`  --color-chart-${index + 1}: var(--chart-${index + 1});`)
})
theme.push('')
theme.push('  /* Типографика */')
theme.push(`  --font-sans: ${tokens.typography.fontFamily.sans};`)
theme.push(`  --font-mono: ${tokens.typography.fontFamily.mono};`)
// Функции OpenType семейства: утилита font-* задаёт их вместе со шрифтом — cv11/ss01
// Inter не включают одноимённые варианты глифов JetBrains Mono, а без calt моно не
// склеивает != или -> в лигатуры: коды и выражения видны знак в знак
theme.push(`  --font-sans--font-feature-settings: ${tokens.typography.fontFeatureSettings.sans};`)
theme.push(`  --font-mono--font-feature-settings: ${tokens.typography.fontFeatureSettings.mono};`)
for (const [name, scale] of Object.entries(tokens.typography.scale)) {
  const s = scale as { size: string; line: string; weight: number; tracking: string }
  theme.push(`  --text-${name}: ${s.size};`)
  theme.push(`  --text-${name}--line-height: ${s.line};`)
  theme.push(`  --text-${name}--font-weight: ${s.weight};`)
  theme.push(`  --text-${name}--letter-spacing: ${s.tracking};`)
}
theme.push('')
theme.push('  /* Сетка 4px */')
theme.push('  --spacing: 4px;')
theme.push('')
theme.push('  /* Радиусы */')
for (const [name, value] of Object.entries(tokens.radius)) {
  theme.push(`  --radius-${name}: ${value};`)
}
theme.push('')
theme.push('  /* Тени */')
for (const name of Object.keys(tokens.shadow)) {
  theme.push(`  --shadow-${name}: var(--elevation-${name});`)
}
theme.push('')
theme.push('  /* Движение */')
for (const [name, value] of Object.entries(tokens.motion.easing)) {
  theme.push(`  --ease-${name}: ${value};`)
}
theme.push('')
theme.push('  /* Анимации */')
theme.push('  --animate-enter: kchs-enter var(--duration-base) var(--ease-standard);')
theme.push('  --animate-slide-up: kchs-slide-up var(--duration-slow) var(--ease-standard);')
theme.push('  --animate-slide-right: kchs-slide-right var(--duration-slow) var(--ease-standard);')
theme.push('  --animate-fade: kchs-fade var(--duration-base) var(--ease-standard);')
theme.push('  --animate-pulse-soft: kchs-pulse 1.6s ease-in-out infinite;')
theme.push('  --animate-spin-fast: kchs-spin 0.7s linear infinite;')
theme.push('}')
theme.push('')

writeFileSync(path.resolve(here, '../src/styles/theme.css'), `${theme.join('\n')}`, 'utf8')

process.stdout.write(`tokens.css: ${light.length} переменных; theme.css: ${theme.length} строк\n`)
