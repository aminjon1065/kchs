/**
 * Проверка контраста WCAG 2.2 AA для текстовых токенов на поверхностях
 * (03-ui/02-design-system.md). Запускается в CI.
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

interface Check {
  name: string
  fg: string
  bg: string
  min: number
}

let failed = 0

for (const theme of ['light', 'dark'] as Theme[]) {
  const surfaces = ['bg-canvas', 'bg-surface', 'bg-surface-2']
  const checks: Check[] = []

  for (const surface of surfaces) {
    checks.push(
      {
        name: `text на ${surface}`,
        fg: neutral.text![theme],
        bg: neutral[surface]![theme],
        min: 4.5,
      },
      {
        name: `text-secondary на ${surface}`,
        fg: neutral['text-secondary']![theme],
        bg: neutral[surface]![theme],
        min: 4.5,
      },
      {
        name: `text-muted на ${surface}`,
        fg: neutral['text-muted']![theme],
        bg: neutral[surface]![theme],
        min: 3,
      },
      {
        name: `accent на ${surface}`,
        fg: accent.accent![theme],
        bg: neutral[surface]![theme],
        min: 3,
      },
      {
        name: `danger на ${surface}`,
        fg: semantic.danger![theme],
        bg: neutral[surface]![theme],
        min: 3,
      },
      {
        name: `success на ${surface}`,
        fg: semantic.success![theme],
        bg: neutral[surface]![theme],
        min: 3,
      },
    )
  }
  checks.push({
    name: 'accent-fg на accent',
    fg: accent['accent-fg']![theme],
    bg: accent.accent![theme],
    min: 4.5,
  })

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

process.stdout.write(failed === 0 ? '\nКонтраст в норме\n' : `\nНарушений контраста: ${failed}\n`)
process.exit(failed === 0 ? 0 : 1)
