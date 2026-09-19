import type { LayerStyleInput } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { compileLayerStyle } from '../compile.js'
import { context, pretty, style, THEME_DARK, validate } from './fixtures.js'

type RendererInput = LayerStyleInput['renderer']

/** По рендереру каждого вида — на точках, линиях и полигонах. */
const RENDERERS: Record<string, RendererInput> = {
  simple: { kind: 'simple', color: 'categorical.2' },
  categorized: {
    kind: 'categorized',
    field: 'kind',
    categories: [
      { value: 'school', color: 'categorical.1' },
      { value: 'hospital', color: 'danger', label: { ru: 'Больницы' } },
      { value: 'police', color: '#1C9A62' },
    ],
    other: { color: 'other' },
  },
  graduated: {
    kind: 'graduated',
    field: 'population',
    method: 'quantile',
    classes: 5,
    palette: { name: 'blue', reverse: false },
  },
  heatmap: { kind: 'heatmap', weightField: 'severity', radius: 24, intensity: 1.5 },
  proportional: {
    kind: 'proportional',
    field: 'capacity',
    min: 6,
    max: 30,
    scale: 'sqrt',
    color: 'teal.6',
  },
  rule: {
    kind: 'rule',
    rules: [
      {
        filter: { field: 'severity', op: 'gte', value: 4 },
        color: 'danger',
        label: { ru: 'Тяжёлые' },
      },
      {
        filter: {
          and: [
            { field: 'active', op: 'is_true' },
            { field: 'kind', op: 'in', value: ['school', 'hospital'] },
          ],
        },
        color: 'success',
      },
    ],
    other: { color: 'neutral', label: { ru: 'Остальные' } },
  },
}

const GEOMETRIES = ['point', 'line', 'polygon'] as const

const CTX = context({
  breaks: [1200, 5000, 12000, 30000, 80000, 250000],
  domains: {
    capacity: { min: 20, max: 1500 },
    severity: { min: 1, max: 5 },
    population: { min: 1200, max: 250000, nulls: 3 },
  },
})

describe('compileLayerStyle — снимки слоёв по рендерерам и геометриям', () => {
  for (const [kind, renderer] of Object.entries(RENDERERS)) {
    for (const geometry of GEOMETRIES) {
      it(`${kind} — ${geometry}`, () => {
        const compiled = compileLayerStyle(
          style({ geometry, renderer, label: { field: 'name' } }),
          CTX,
        )
        expect(validate(compiled.layers)).toEqual([])
        expect(pretty(compiled)).toMatchSnapshot()
      })
    }
  }
})

describe('compileLayerStyle — снимки особых случаев', () => {
  const cases: Record<string, [Omit<LayerStyleInput, 'version'>, Parameters<typeof context>[0]?]> =
    {
      'точки с кластерами, фигурой и размером по полю': [
        {
          geometry: 'point',
          renderer: { kind: 'simple', color: 'accent' },
          point: {
            shape: 'square',
            size: 10,
            sizeBy: { field: 'capacity', min: 4, max: 24, scale: 'linear' },
          },
          cluster: { enabled: true },
          label: { template: '{{name}} ({{capacity}})', priority: 'size', minZoom: 12 },
        },
        { domains: { capacity: { min: 20, max: 1500 }, point_count: { min: 2, max: 5000 } } },
      ],
      'категории со значками и размерами, «прочее» не рисуется': [
        {
          geometry: 'point',
          renderer: {
            kind: 'categorized',
            field: 'kind',
            categories: [
              { value: 'school', color: 'categorical.1', icon: 'school', size: 14 },
              { value: 'hospital', color: 'danger', icon: 'hospital' },
              { value: null, color: 'neutral', label: { ru: 'Не указан' } },
            ],
            other: null,
          },
        },
      ],
      'хороплет с нормализацией в тёмной теме': [
        {
          geometry: 'polygon',
          renderer: {
            kind: 'graduated',
            field: 'population',
            method: 'jenks',
            classes: 4,
            palette: { name: 'viridis', reverse: false },
            normalizeBy: 'area_km2',
          },
          polygon: { fillOpacity: 0.75, outline: { width: 0.5, color: 'auto' } },
          label: { field: 'population', halo: true, minZoom: 7, placement: 'auto' },
          legend: { title: { ru: 'Население на км²' }, format: { precision: 0 } },
        },
        { theme: THEME_DARK, breaks: [0.5, 12, 60, 240, 1800] },
      ],
      'расходящаяся шкала и размер классов на линиях': [
        {
          geometry: 'line',
          renderer: {
            kind: 'graduated',
            field: 'ratio',
            method: 'manual',
            classes: 5,
            breaks: [-1, -0.5, -0.1, 0.1, 0.5, 1],
            palette: { name: 'brown-teal', reverse: true },
            visual: { target: 'both' },
          },
          line: { width: 1.5, dash: [2, 1], cap: 'butt' },
        },
      ],
      'время и фильтр слоя на клиенте (GeoJSON)': [
        {
          geometry: 'point',
          renderer: { kind: 'simple', color: 'warning' },
          filter: {
            and: [
              { field: 'kind', op: 'in', value: ['school', 'police'] },
              { field: 'territory_id', op: 'is_me' },
            ],
          },
          time: { field: 'occurred_at', mode: 'instant', step: 'day' },
          minZoom: 5,
          maxZoom: 18,
        },
        {
          sourceLayer: null,
          source: 'objects-geojson',
          clientFilter: true,
          time: { from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 8, 2) },
        },
      ],
    }
  for (const [name, [input, overrides]] of Object.entries(cases)) {
    it(name, () => {
      const compiled = compileLayerStyle(style(input), context(overrides))
      expect(validate(compiled.layers)).toEqual([])
      expect(pretty(compiled)).toMatchSnapshot()
    })
  }
})
