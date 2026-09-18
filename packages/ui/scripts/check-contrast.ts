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

process.stdout.write(failed === 0 ? '\nКонтраст в норме\n' : `\nНарушений контраста: ${failed}\n`)
process.exit(failed === 0 ? 0 : 1)
