import { LayerStyle, type LayerStyleInput } from '@kchs/contracts'
import {
  createPropertyExpression,
  featureFilter,
  type LayerSpecification,
  latest,
  type StyleSpecification,
  validateStyleMin,
} from '@maplibre/maplibre-gl-style-spec'
import type { MapStyleContext, MapTheme, StyleField } from '../model.js'

/** Светлая тема — значения из tokens.json (viz, --seq-*, --div-*), как их отдаёт дизайн-система. */
export const THEME_LIGHT: MapTheme = {
  mode: 'light',
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
  sequential: {
    blue: ['#E9EFFF', '#C6D5FB', '#9FB9F8', '#759BF5', '#4D7BEE', '#305CD2', '#193CA0'],
    teal: ['#DEF5F8', '#ADE3E9', '#77CED9', '#3DB4C3', '#0B97A7', '#007A87', '#005B66'],
    orange: ['#FDEFE0', '#F7D3B2', '#F3B37F', '#EC9249', '#DA751D', '#AE5B1D', '#824115'],
    viridis: ['#FDE725', '#90D743', '#35B779', '#21918C', '#31688E', '#443983', '#440154'],
  },
  diverging: {
    'red-blue': ['#D63B3B', '#E98080', '#F5C0C0', '#F1F1F3', '#BCD0F7', '#7DA0EC', '#2F62E6'],
    'brown-teal': ['#965719', '#CA924C', '#E4CA9E', '#F1F1F3', '#A8D8DB', '#56AEB8', '#147684'],
  },
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
  surface: '#FFFFFF',
}

export const THEME_DARK: MapTheme = {
  mode: 'dark',
  categorical: [
    '#2F62E6',
    '#C96B1E',
    '#D9509C',
    '#B28D09',
    '#0EA5B7',
    '#D63B3B',
    '#8B5CF6',
    '#1C9A62',
  ],
  other: '#8497A8',
  sequential: {
    blue: ['#26365C', '#314C8C', '#3D63BE', '#527DE5', '#729AFB', '#9CB9FF', '#C7D7FF'],
    teal: ['#103F45', '#0C5A63', '#007782', '#0095A1', '#2CB2BD', '#61CED4', '#96E8EA'],
    orange: ['#512E1B', '#763F1D', '#9D521A', '#C46716', '#E3832F', '#F2A866', '#FACF9E'],
    viridis: ['#440154', '#443983', '#31688E', '#21918C', '#35B779', '#90D743', '#FDE725'],
  },
  diverging: {
    'red-blue': ['#F06B6B', '#A85556', '#643E40', '#25262B', '#414C6B', '#5F75B2', '#7EA0FF'],
    'brown-teal': ['#D49648', '#9F6A30', '#664526', '#25262B', '#1C565D', '#31858C', '#4FB7BC'],
  },
  tokens: {
    accent: '#7EA0FF',
    success: '#4CCB8E',
    warning: '#F2B84B',
    danger: '#F06B6B',
    info: '#7EA0FF',
    neutral: '#8A8C99',
    purple: '#A78BFA',
  },
  text: '#ECECEF',
  surface: '#16171A',
}

/** Поля датасета «Объекты и происшествия» (районы Таджикистана). */
export const FIELDS: StyleField[] = [
  { key: 'name', type: 'text', label: { ru: 'Название', en: 'Name' } },
  {
    key: 'kind',
    type: 'select',
    label: { ru: 'Вид', en: 'Kind' },
    options: [
      { value: 'school', label: { ru: 'Школа', en: 'School' } },
      { value: 'hospital', label: { ru: 'Больница', en: 'Hospital' } },
      { value: 'police', label: { ru: 'Полиция', en: 'Police' } },
    ],
  },
  { key: 'capacity', type: 'integer', label: { ru: 'Вместимость' } },
  { key: 'population', type: 'integer', label: { ru: 'Население' } },
  { key: 'area_km2', type: 'decimal', label: { ru: 'Площадь, км²' }, format: { precision: 1 } },
  { key: 'damage', type: 'money', label: { ru: 'Ущерб' }, format: { currency: 'TJS' } },
  { key: 'severity', type: 'integer', label: { ru: 'Тяжесть' } },
  { key: 'ratio', type: 'decimal', label: { ru: 'Коэффициент' } },
  { key: 'active', type: 'boolean', label: { ru: 'Действует' } },
  { key: 'occurred_at', type: 'datetime', label: { ru: 'Время' } },
  { key: 'reported_on', type: 'date', label: { ru: 'Дата донесения' } },
  { key: 'territory_id', type: 'territory', label: { ru: 'Территория' } },
  { key: 'share', type: 'percent', label: { ru: 'Доля' }, format: { precision: 1 } },
  { key: 'tags', type: 'multi_select', label: { ru: 'Метки' } },
]

export function style(input: Omit<LayerStyleInput, 'version'>): LayerStyle {
  return LayerStyle.parse({ version: 1, ...input })
}

export function context(overrides: Partial<MapStyleContext> = {}): MapStyleContext {
  return {
    id: 'objects',
    source: 'objects-tiles',
    fields: FIELDS,
    theme: THEME_LIGHT,
    locale: 'ru',
    name: 'Объекты',
    ...overrides,
  }
}

/** Слои в минимальном стиле MapLibre: ошибки `validateStyleMin` (пусто — слои корректны). */
export function validate(layers: LayerSpecification[]): string[] {
  const spec: StyleSpecification = {
    version: 8,
    glyphs: 'https://tiles.example/glyphs/{fontstack}/{range}.pbf',
    sources: {
      'objects-tiles': { type: 'vector', tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] },
      'objects-geojson': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers,
  }
  return validateStyleMin(spec).map((error) => error.message)
}

type Properties = Record<string, unknown>

const FEATURE_TYPES = { point: 1, line: 2, polygon: 3 } as const

function feature(properties: Properties, geometry: keyof typeof FEATURE_TYPES = 'point') {
  return { type: FEATURE_TYPES[geometry], properties } as never
}

/** Проходит ли объект фильтр слоя. */
export function passes(layer: LayerSpecification, properties: Properties, zoom = 10): boolean {
  const filter = 'filter' in layer ? layer.filter : undefined
  if (filter === undefined) return true
  return featureFilter(filter, `layers.${layer.id}.filter`).filter(
    { zoom } as never,
    feature(properties),
  )
}

/** Значение свойства слоя (paint/layout) для объекта: цвет — hex, число — число. */
export function evaluate(
  layer: LayerSpecification,
  property: string,
  properties: Properties,
  zoom = 10,
): unknown {
  const group =
    (layer as { paint?: Record<string, unknown> }).paint?.[property] !== undefined
      ? 'paint'
      : 'layout'
  const value = (layer as unknown as Record<string, Record<string, unknown> | undefined>)[group]?.[
    property
  ]
  const reference = (latest as unknown as Record<string, Record<string, object>>)[
    `${group}_${layer.type}`
  ]?.[property]
  if (!reference) throw new Error(`нет свойства ${group}_${layer.type}.${property}`)
  const compiled = createPropertyExpression(
    value,
    `layers.${layer.id}.${group}.${property}`,
    reference as never,
  )
  if (compiled.result !== 'success') {
    throw new Error(JSON.stringify(compiled.value.map((e) => e.message)))
  }
  const out = compiled.value.evaluate({ zoom } as never, feature(properties))
  return toPlain(out)
}

function toPlain(value: unknown): unknown {
  if (value && typeof value === 'object' && 'r' in value && 'g' in value && 'b' in value) {
    const color = value as { r: number; g: number; b: number; a: number }
    const channel = (v: number) =>
      Math.round((color.a === 0 ? 0 : v / color.a) * 255)
        .toString(16)
        .padStart(2, '0')
    return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`.toUpperCase()
  }
  if (value && typeof value === 'object' && 'name' in value) return (value as { name: string }).name
  if (value && typeof value === 'object' && 'sections' in value) {
    return (value as { sections: Array<{ text: string }> }).sections.map((s) => s.text).join('')
  }
  return value
}

export function layer(layers: LayerSpecification[], role: string): LayerSpecification {
  const found = layers.find((l) => l.id.endsWith(`:${role}`))
  if (!found) throw new Error(`нет слоя с ролью ${role}: ${layers.map((l) => l.id).join(', ')}`)
  return found
}

/** Компактный JSON для снимков: короткие массивы и объекты — в строку. */
export function pretty(value: unknown, indent = ''): string {
  const inline = JSON.stringify(value)
  if (inline === undefined) return 'undefined'
  if (value === null || typeof value !== 'object' || inline.length <= 96) return inline
  const next = `${indent}  `
  if (Array.isArray(value)) {
    return `[\n${value.map((item) => next + pretty(item, next)).join(',\n')}\n${indent}]`
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  )
  return `{\n${entries.map(([key, v]) => `${next}${JSON.stringify(key)}: ${pretty(v, next)}`).join(',\n')}\n${indent}}`
}
