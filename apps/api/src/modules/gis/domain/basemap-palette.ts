import type { BasemapTheme } from '@kchs/contracts'

/**
 * Цвета подложки из токенов дизайн-системы (02-design-system.md §4): приглушённый
 * фон, чтобы данные всегда были контрастнее. Значения повторяют
 * `packages/ui/src/tokens/tokens.json` — расхождение ловит unit-тест.
 * Свои оттенки карты — только вода и здания из 02-design-system.md §4.
 */
export const TOKEN_COLORS = {
  light: {
    'bg-canvas': '#F4F5F8',
    'bg-surface': '#FFFFFF',
    'bg-surface-2': '#EFF1F5',
    'bg-surface-3': '#E6E9EF',
    border: '#E2E5EC',
    'border-strong': '#CDD2DC',
    text: '#0F1422',
    'text-secondary': '#465066',
    'text-muted': '#5F687D',
    accent: '#2F62E6',
    'accent-subtle': '#EAF0FF',
    'success-subtle': '#E5F5EC',
  },
  dark: {
    'bg-canvas': '#0A0D14',
    'bg-surface': '#11151E',
    'bg-surface-2': '#171C27',
    'bg-surface-3': '#1F2533',
    border: '#232A38',
    'border-strong': '#323B4D',
    text: '#E8EBF2',
    'text-secondary': '#A5ADBF',
    'text-muted': '#8B93A8',
    accent: '#7EA0FF',
    'accent-subtle': '#19233F',
    'success-subtle': '#0F2A1E',
  },
} as const

/** Оттенки карты из 02-design-system.md §4 и последовательной палитры `blue`. */
export const MAP_COLORS = {
  water: '#D9E4F5',
  building: '#ECECEF',
  /** `color.sequential.blue.light[1]` — реки заметнее водоёмов на тонких линиях. */
  river: '#C6D5FB',
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
  /**
   * Непрозрачность отмывки рельефа (ADR-0195): на тёмной теме видны только освещённые
   * склоны — она выше, под хороплетами («приглушённая») — ниже.
   */
  relief: number
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
    relief: 0.4,
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
    relief: 0.5,
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
    relief: 0.3,
  },
}

/**
 * Подписи, дороги и границы поверх космического снимка — «Гибрид» (ADR-0196): светлый текст
 * и линии с тёмным гало, как в тёмной теме. Не тема: земли, воды и зданий у наложения нет.
 */
export const OVERLAY_PALETTE: Palette = {
  ...PALETTES.dark,
  land: null,
  residential: null,
  building: null,
  roadMajor: light['bg-surface'],
  roadCasing: dark['bg-canvas'],
  rail: dark.text,
  boundary: dark.text,
  label: dark.text,
  labelStrong: dark.text,
  labelMuted: dark['text-secondary'],
  relief: 0,
}
