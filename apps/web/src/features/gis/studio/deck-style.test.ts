import { LayerStyle } from '@kchs/contracts'
import {
  compileLayerStyle,
  type MapStyleContext,
  type MapTheme,
  type StyleField,
} from '@kchs/map-style'
import type { MapLayerSpecification } from '@kchs/ui'
import { describe, expect, it } from 'vitest'
import { deckDrawable, deckSelectionColor } from './deck-roles.js'
import { deckPaint } from './deck-style.js'

/**
 * Мост стилей deck.gl (ADR-0110): цвета и размеры для deck.gl берутся из того
 * же скомпилированного стиля MapLibre, что рисует карта. Проверяем, что мост
 * даёт ровно цвета стиля и что слои, которых deck.gl не рисует, остаются
 * у MapLibre.
 */

const THEME: MapTheme = {
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

const FIELDS: StyleField[] = [
  { key: 'name', type: 'text', label: { ru: 'Название' } },
  { key: 'kind', type: 'select', label: { ru: 'Вид' } },
  { key: 'capacity', type: 'integer', label: { ru: 'Вместимость' } },
]

function context(overrides: Partial<MapStyleContext> = {}): MapStyleContext {
  return {
    id: 'objects',
    source: 'layer-objects',
    fields: FIELDS,
    theme: THEME,
    locale: 'ru',
    name: 'Объекты',
    ...overrides,
  }
}

function compiled(input: Record<string, unknown>, ctx = context()): MapLayerSpecification[] {
  return compileLayerStyle(LayerStyle.parse({ version: 1, ...input }), ctx)
    .layers as unknown as MapLayerSpecification[]
}

type Rgba = [number, number, number, number]

const hex = (color: Rgba) =>
  `#${color
    .slice(0, 3)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`

describe('deck.gl: мост стилей', () => {
  it('простой стиль точек даёт цвет и радиус стиля', () => {
    const layers = compiled({
      geometry: 'point',
      renderer: { kind: 'simple', color: '#2F62E6' },
      point: { size: 10 },
    })
    const paint = deckPaint(layers)
    expect(paint).not.toBeNull()
    expect(paint?.kind).toBe('circle')
    expect(hex(paint?.fillColor({}, 10) as Rgba)).toBe('#2F62E6')
    // Размер стиля — диаметр, радиус круга MapLibre — половина
    expect(paint?.radius({}, 10)).toBe(5)
  })

  it('категории окрашиваются по значению поля', () => {
    const layers = compiled({
      geometry: 'point',
      renderer: {
        kind: 'categorized',
        field: 'kind',
        categories: [
          { value: 'school', color: '#2F62E6' },
          { value: 'hospital', color: '#D63B3B' },
        ],
        other: { color: '#5B7083' },
      },
    })
    const paint = deckPaint(layers)
    const color = (kind: string) => hex(paint?.fillColor({ kind }, 10) as Rgba)
    expect(color('school')).toBe('#2F62E6')
    expect(color('hospital')).toBe('#D63B3B')
    expect(color('police')).toBe('#5B7083')
  })

  it('градуированный стиль полигонов: значение и «нет данных» — разные цвета', () => {
    const layers = compiled(
      {
        geometry: 'polygon',
        renderer: {
          kind: 'graduated',
          field: 'capacity',
          method: 'manual',
          classes: 3,
          ramp: 'blue',
          breaks: [10, 20],
        },
      },
      context({ breaks: [10, 20] }),
    )
    const paint = deckPaint(layers)
    expect(paint?.kind).toBe('fill')
    const value = paint?.fillColor({ capacity: 15 }, 10) as Rgba
    const empty = paint?.fillColor({}, 10) as Rgba
    expect(hex(value)).not.toBe(hex(empty))
    // Прозрачность заливки полигонов стиля (0,6) — в альфе цвета deck.gl
    expect(value[3]).toBeLessThan(255)
    // Обводка полигона — из слоя роли `outline`
    expect(paint?.lineWidth({}, 10)).toBe(1)
  })

  it('прозрачность слоя карты уходит в альфу', () => {
    const layers = compiled({
      geometry: 'point',
      renderer: { kind: 'simple', color: '#2F62E6' },
      opacity: 0.5,
    })
    const paint = deckPaint(layers)
    expect(paint).not.toBeNull()
    const color = (paint as NonNullable<typeof paint>).fillColor({}, 10) as Rgba
    expect(color[3]).toBeGreaterThan(100)
    expect(color[3]).toBeLessThan(160)
  })

  it('стиль «по правилам» окрашивает по условию правила', () => {
    const layers = compiled({
      geometry: 'point',
      renderer: {
        kind: 'rule',
        rules: [
          { filter: { field: 'kind', op: 'eq', value: 'school' }, color: '#2F62E6' },
          { filter: { field: 'kind', op: 'eq', value: 'hospital' }, color: '#D63B3B' },
        ],
        other: { color: '#5B7083' },
      },
    })
    const paint = deckPaint(layers)
    const color = (kind: string) => hex(paint?.fillColor({ kind }, 10) as Rgba)
    expect(color('school')).toBe('#2F62E6')
    expect(color('hospital')).toBe('#D63B3B')
    expect(color('police')).toBe('#5B7083')
  })

  it('фильтр слоя применяет сервер: в стиле условия нет, объект виден', () => {
    // Условие слоя уходит параметром `f` в адрес тайлов, поэтому в стиле его нет
    const layers = compiled({
      geometry: 'point',
      renderer: { kind: 'simple', color: '#2F62E6' },
      filter: { field: 'kind', op: 'eq', value: 'school' },
    })
    const paint = deckPaint(layers)
    expect(paint?.visible({ kind: 'police' }, 10)).toBe(true)
  })
})

describe('deck.gl: что остаётся у MapLibre', () => {
  it('простые точки и полигоны рисует deck.gl', () => {
    expect(
      deckDrawable(compiled({ geometry: 'point', renderer: { kind: 'simple', color: 'accent' } })),
    ).toBe(true)
    expect(
      deckDrawable(
        compiled({ geometry: 'polygon', renderer: { kind: 'simple', color: 'accent' } }),
      ),
    ).toBe(true)
  })

  it('кластеры, подписи, тепловая карта и значки — только MapLibre', () => {
    const cluster = compiled({
      geometry: 'point',
      renderer: { kind: 'simple', color: 'accent' },
      cluster: { enabled: true },
    })
    expect(deckDrawable(cluster)).toBe(false)

    const labelled = compiled({
      geometry: 'point',
      renderer: { kind: 'simple', color: 'accent' },
      label: { field: 'name' },
    })
    expect(deckDrawable(labelled)).toBe(false)

    const heatmap = compiled({
      geometry: 'point',
      renderer: { kind: 'heatmap', field: null, radius: 20, intensity: 1, ramp: 'blue' },
    })
    expect(deckDrawable(heatmap)).toBe(false)

    const icons = compiled({
      geometry: 'point',
      renderer: { kind: 'simple', color: 'accent' },
      point: { shape: 'triangle' },
    })
    expect(deckDrawable(icons)).toBe(false)
  })

  it('несколько слоёв одной роли deck.gl не берёт: он рисует слой одной краской', () => {
    const doubled = [
      ...compiled({ geometry: 'point', renderer: { kind: 'simple', color: 'accent' } }),
      ...compiled({ geometry: 'point', renderer: { kind: 'simple', color: 'danger' } }),
    ]
    expect(deckDrawable(doubled)).toBe(false)
  })

  it('пустой набор слоёв deck.gl не берёт', () => {
    expect(deckDrawable([])).toBe(false)
  })
})

describe('deck.gl: цвет выделения', () => {
  it('берётся акцент темы', () => {
    expect(deckSelectionColor(THEME)).toEqual([47, 98, 230, 255])
  })

  it('без темы — запасной цвет, а не падение', () => {
    expect(deckSelectionColor(null)).toHaveLength(4)
  })
})
