import type { BasemapTheme } from '@kchs/contracts'

/**
 * Цвета подложки из токенов дизайн-системы (02-design-system.md §4): приглушённый
 * фон, чтобы данные всегда были контрастнее. Значения повторяют
 * `packages/ui/src/tokens/tokens.json` — расхождение ловит unit-тест.
 * Свои оттенки карты — только вода и здания из 02-design-system.md §4.
 */
export const TOKEN_COLORS = {
  light: {
    'bg-canvas': '#F6F6F7',
    'bg-surface': '#FFFFFF',
    'bg-surface-2': '#F1F1F3',
    'bg-surface-3': '#E9E9EC',
    border: '#E4E4E8',
    'border-strong': '#D2D2D8',
    text: '#17181C',
    'text-secondary': '#4F5160',
    'text-muted': '#666875',
    accent: '#2F62E6',
    'accent-subtle': '#E9EFFF',
    'success-subtle': '#E6F6EE',
  },
  dark: {
    'bg-canvas': '#0E0F11',
    'bg-surface': '#16171A',
    'bg-surface-2': '#1D1E22',
    'bg-surface-3': '#25262B',
    border: '#2A2B31',
    'border-strong': '#3A3B42',
    text: '#ECECEF',
    'text-secondary': '#A6A7B2',
    'text-muted': '#8A8C99',
    accent: '#7EA0FF',
    'accent-subtle': '#1A2440',
    'success-subtle': '#0F2A1E',
  },
} as const

/** Оттенки карты из 02-design-system.md §4 и последовательной палитры `blue`. */
export const MAP_COLORS = {
  water: '#D9E4F5',
  building: '#ECECEF',
  /** `color.sequential.blue[1]` — реки заметнее водоёмов на тонких линиях. */
  river: '#C6D6FA',
} as const

export interface Palette {
  background: string
  /** Растительность, ледники, голые скалы и пески; null — без подложки земли (muted). */
  land: { vegetation: string; ice: string; bare: string; opacity: number } | null
  residential: string | null
  building: string | null
  water: string
  waterway: string
  roadMinor: string
  roadMajor: string
  /** Обводка крупных дорог; null — без обводки. */
  roadCasing: string | null
  rail: string
  boundary: string
  label: string
  labelStrong: string
  labelMuted: string
  labelWater: string
  halo: string
}

const light = TOKEN_COLORS.light
const dark = TOKEN_COLORS.dark

export const PALETTES: Record<BasemapTheme, Palette> = {
  light: {
    background: light['bg-canvas'],
    land: {
      vegetation: light['success-subtle'],
      ice: light['bg-surface'],
      bare: light['bg-surface-2'],
      opacity: 0.9,
    },
    residential: light['bg-surface-3'],
    building: MAP_COLORS.building,
    water: MAP_COLORS.water,
    waterway: MAP_COLORS.river,
    roadMinor: light.border,
    roadMajor: light['bg-surface'],
    roadCasing: light['border-strong'],
    rail: light['border-strong'],
    boundary: light['text-muted'],
    label: light['text-secondary'],
    labelStrong: light.text,
    labelMuted: light['text-muted'],
    labelWater: light.accent,
    halo: light['bg-canvas'],
  },
  dark: {
    background: dark['bg-canvas'],
    land: {
      vegetation: dark['success-subtle'],
      ice: dark['bg-surface-3'],
      bare: dark['bg-surface'],
      opacity: 0.8,
    },
    residential: dark['bg-surface-2'],
    building: dark['bg-surface-3'],
    water: dark['accent-subtle'],
    waterway: dark['accent-subtle'],
    roadMinor: dark.border,
    roadMajor: dark['border-strong'],
    roadCasing: null,
    rail: dark['border-strong'],
    boundary: dark['text-muted'],
    label: dark['text-secondary'],
    labelStrong: dark.text,
    labelMuted: dark['text-muted'],
    labelWater: dark.accent,
    halo: dark['bg-canvas'],
  },
  // Серая подложка под хороплеты и тепловые карты: без растительности и зданий
  muted: {
    background: light['bg-surface'],
    land: null,
    residential: null,
    building: null,
    water: light['bg-surface-3'],
    waterway: light['bg-surface-3'],
    roadMinor: light['bg-surface-2'],
    roadMajor: light.border,
    roadCasing: null,
    rail: light.border,
    boundary: light['text-muted'],
    label: light['text-muted'],
    labelStrong: light['text-secondary'],
    labelMuted: light['text-muted'],
    labelWater: light['text-muted'],
    halo: light['bg-surface'],
  },
}
