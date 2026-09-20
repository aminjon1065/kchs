import { ChartSpec, type QueryResult, type QueryResultField } from '@kchs/contracts'
import type { ChartTheme } from '../theme.js'

/** Тема светлая — значения из tokens.json (viz), как их отдаёт дизайн-система. */
export const THEME: ChartTheme = {
  mode: 'light',
  fontFamily: 'Inter',
  categorical: [
    '#2F62E6',
    '#E8842F',
    '#D9509C',
    '#C9A227',
    '#0EA5B7',
    '#D63B3B',
    '#8B5CF6',
    '#1C9A62',
  ],
  other: '#5B7083',
  sequential: ['#E9EFFF', '#C6D6FA', '#9DB9F2', '#6E96E9', '#2F62E6', '#1A3A9E'],
  diverging: ['#D63B3B', '#E98080', '#F5C0C0', '#F1F1F3', '#BCD0F7', '#7DA0EC', '#2F62E6'],
  tokens: {
    accent: '#2F62E6',
    success: '#177E50',
    warning: '#936500',
    danger: '#CE2B2B',
    info: '#2F62E6',
    neutral: '#666875',
    purple: '#7B45F5',
  },
  text: '#17181C',
  textSecondary: '#4F5160',
  textMuted: '#666875',
  textInverse: '#FFFFFF',
  surface: '#FFFFFF',
  overlay: '#FFFFFF',
  grid: '#E4E4E8',
  axis: '#D2D2D8',
  shadow: '0 4px 12px rgba(16,17,20,.08)',
}

type FieldSpec = Pick<QueryResultField, 'name' | 'type'> & Partial<QueryResultField>

export function result(fields: FieldSpec[], rows: unknown[][]): QueryResult {
  return {
    fields: fields.map((f) => ({
      semantic: null,
      label: null,
      format: null,
      ...f,
    })),
    rows,
    rowCount: rows.length,
    approx: false,
    truncated: false,
    durationMs: 1,
    cached: false,
    executedOn: 'postgres',
  }
}

export function spec(input: Record<string, unknown>): ChartSpec {
  return ChartSpec.parse({
    version: 1,
    data: { queryId: '01928c4e-7a3b-7c3d-9e4f-0a1b2c3d4e5f' },
    encoding: {},
    ...input,
  })
}

/** Происшествия по районам. */
export const DISTRICTS = result(
  [
    { name: 'district', type: 'text', semantic: 'dimension', label: { ru: 'Район' } },
    { name: 'incidents', type: 'integer', semantic: 'measure', label: { ru: 'Происшествия' } },
    { name: 'damage', type: 'decimal', semantic: 'measure', label: { ru: 'Ущерб' } },
  ],
  [
    ['Рудаки', 42, 1240.5],
    ['Варзоб', 17, 5870],
    ['Вахдат', 28, 930],
    ['Гиссар', 9, 410],
    ['Файзабад', 5, 120],
    ['Турсунзаде', 12, 2210],
    ['Шахринав', 3, 80],
    ['Рашт', 21, 3400],
    ['Нурабад', 7, 260],
    ['Таджикабад', 4, 95],
  ],
)

const MONTHS = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01']

/** Происшествия по месяцам и регионам. */
export const MONTHLY = result(
  [
    { name: 'month', type: 'date', semantic: 'time', label: { ru: 'Месяц' } },
    { name: 'region', type: 'text', semantic: 'dimension', label: { ru: 'Регион' } },
    { name: 'incidents', type: 'integer', semantic: 'measure', label: { ru: 'Происшествия' } },
  ],
  MONTHS.flatMap((month, i) => [
    [month, 'Хатлон', 20 + i * 3],
    [month, 'Согд', 14 + ((i * 5) % 7)],
    [month, 'РРП', 9 + i],
  ]),
)

/** Один ряд по месяцам. */
export const SERIES = result(
  [
    { name: 'month', type: 'date', semantic: 'time', label: { ru: 'Месяц' } },
    { name: 'incidents', type: 'integer', semantic: 'measure', label: { ru: 'Происшествия' } },
  ],
  MONTHS.map((month, i) => [month, [31, 28, 35, 40, 38, 44][i]]),
)
