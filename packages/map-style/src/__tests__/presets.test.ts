import { LayerStyle } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { classify, classifySummary } from '../classify.js'
import {
  applyStylePreset,
  categoriesFor,
  defaultRenderer,
  fieldsFor,
  type PresetField,
  stylePresets,
} from '../presets.js'

/** Поля «Объектов защиты»: код, вид, район, вместимость, население, дата, место. */
const FIELDS: PresetField[] = [
  { key: 'code', type: 'identifier', semantic: 'identifier' },
  { key: 'name', type: 'text', semantic: 'dimension' },
  {
    key: 'kind',
    type: 'select',
    semantic: 'dimension',
    options: [{ value: 'school' }, { value: 'hospital' }],
  },
  { key: 'district', type: 'text', semantic: 'category' },
  { key: 'capacity', type: 'integer', semantic: 'measure' },
  { key: 'floor', type: 'integer', semantic: 'dimension' },
  { key: 'opened', type: 'date', semantic: 'time' },
  { key: 'place', type: 'geometry', semantic: 'geometry' },
  { key: '_id', type: 'integer', semantic: 'system' },
]

const base = (geometry: 'point' | 'line' | 'polygon') =>
  LayerStyle.parse({ version: 1, geometry, renderer: { kind: 'simple', color: 'teal.6' } })

describe('пресеты по семантике полей', () => {
  it('точки: категории, меры (классы и размер), тепловая карта, время', () => {
    expect(stylePresets(FIELDS, 'point').map((preset) => preset.id)).toEqual([
      'simple',
      'categorized:kind',
      'categorized:district',
      'graduated:capacity',
      'proportional:capacity',
      'heatmap',
      'time:opened',
    ])
  })

  it('полигоны: без размера и тепловой карты; целое-измерение — не мера', () => {
    const ids = stylePresets(FIELDS, 'polygon').map((preset) => preset.id)
    expect(ids).toEqual([
      'simple',
      'categorized:kind',
      'categorized:district',
      'graduated:capacity',
      'time:opened',
    ])
    expect(ids).not.toContain('graduated:floor')
  })

  it('поля без семантики: числа — меры, даты — время', () => {
    const plain: PresetField[] = [
      { key: 'amount', type: 'number' },
      { key: 'day', type: 'datetime' },
    ]
    expect(stylePresets(plain, 'line').map((preset) => preset.id)).toEqual([
      'simple',
      'graduated:amount',
      'time:day',
    ])
  })

  it('пресет «по категориям» — значения, самые частые первыми, и «прочее»', () => {
    const style = applyStylePreset(
      base('point'),
      { id: 'categorized:district', kind: 'categorized', field: 'district' },
      { fields: FIELDS, categories: ['Хатлон', 'Согд', null, 'Хатлон'] },
    )
    expect(style.renderer).toEqual({
      kind: 'categorized',
      field: 'district',
      categories: [
        { value: 'Хатлон', color: 'categorical.1' },
        { value: 'Согд', color: 'categorical.2' },
        { value: null, color: 'neutral' },
      ],
      other: { color: 'other' },
    })
    // Результат проходит контракт LayerStyle
    expect(LayerStyle.parse(style)).toEqual(style)
  })

  it('без значений категорий — варианты выбора поля', () => {
    const style = applyStylePreset(
      base('point'),
      { id: 'categorized:kind', kind: 'categorized', field: 'kind' },
      { fields: FIELDS },
    )
    expect(style.renderer).toMatchObject({
      field: 'kind',
      categories: [
        { value: 'school', color: 'categorical.1' },
        { value: 'hospital', color: 'categorical.2' },
      ],
    })
  })

  it('мера → градуированный и пропорциональный; цвет простого стиля переносится', () => {
    const graduated = applyStylePreset(
      base('polygon'),
      { id: 'graduated:capacity', kind: 'graduated', field: 'capacity' },
      { fields: FIELDS },
    )
    expect(graduated.renderer).toEqual({
      kind: 'graduated',
      field: 'capacity',
      method: 'quantile',
      classes: 5,
      breaks: null,
      palette: { name: 'blue', reverse: false },
      normalizeBy: null,
      visual: { target: 'fill' },
    })
    const proportional = applyStylePreset(
      base('point'),
      { id: 'proportional:capacity', kind: 'proportional', field: 'capacity' },
      { fields: FIELDS },
    )
    expect(proportional.renderer).toEqual({
      kind: 'proportional',
      field: 'capacity',
      min: 4,
      max: 24,
      scale: 'sqrt',
      color: 'teal.6',
    })
    expect(LayerStyle.parse(proportional)).toEqual(proportional)
  })

  it('время: поле и шаг, рендерер не меняется', () => {
    const style = applyStylePreset(
      base('point'),
      { id: 'time:opened', kind: 'time', field: 'opened' },
      { fields: FIELDS },
    )
    expect(style.time).toEqual({ field: 'opened', mode: 'range', step: 'day' })
    expect(style.renderer).toEqual(base('point').renderer)
  })
})

describe('рендерер по умолчанию при смене вида', () => {
  it('поле переносится, если подходит; иначе — первое подходящее', () => {
    const graduated = defaultRenderer('graduated', {
      fields: FIELDS,
      geometry: 'polygon',
      previous: {
        kind: 'proportional',
        field: 'capacity',
        min: 4,
        max: 24,
        scale: 'sqrt',
        color: 'categorical.1',
      },
    })
    expect(graduated).toMatchObject({ kind: 'graduated', field: 'capacity' })
    const categorized = defaultRenderer('categorized', {
      fields: FIELDS,
      geometry: 'polygon',
      previous: graduated,
    })
    // capacity — целое, по категориям годится
    expect(categorized).toMatchObject({ kind: 'categorized', field: 'capacity', categories: [] })
    // Без поля — сначала категория по смыслу, код объекта не предлагается
    const first = defaultRenderer('categorized', { fields: FIELDS, geometry: 'point' })
    expect(first).toMatchObject({ field: 'kind' })
    const plain = defaultRenderer('categorized', {
      fields: FIELDS.filter((field) => field.key !== 'kind' && field.key !== 'district'),
      geometry: 'point',
    })
    expect(plain).toMatchObject({ field: 'name' })
  })

  it('недоступные виды: нет чисел, размер у полигонов, тепловая не у точек', () => {
    const text: PresetField[] = [{ key: 'name', type: 'text' }]
    expect(defaultRenderer('graduated', { fields: text, geometry: 'point' })).toBeNull()
    expect(defaultRenderer('proportional', { fields: FIELDS, geometry: 'polygon' })).toBeNull()
    expect(defaultRenderer('heatmap', { fields: FIELDS, geometry: 'line' })).toBeNull()
    expect(defaultRenderer('heatmap', { fields: FIELDS, geometry: 'point' })).toMatchObject({
      weightField: null,
    })
    expect(defaultRenderer('rule', { fields: [], geometry: 'point' })).toBeNull()
  })

  it('правила: одно правило «поле не пустое» и «прочее»', () => {
    const rule = defaultRenderer('rule', { fields: FIELDS, geometry: 'point' })
    expect(rule).toEqual({
      kind: 'rule',
      rules: [{ filter: { field: 'code', op: 'not_empty' }, color: 'categorical.1' }],
      other: { color: 'other' },
    })
  })

  it('роли полей: системные и геометрия не предлагаются', () => {
    expect(fieldsFor(FIELDS, 'number').map((field) => field.key)).toEqual(['capacity', 'floor'])
    expect(fieldsFor(FIELDS, 'label').map((field) => field.key)).not.toContain('place')
    expect(fieldsFor(FIELDS, 'label').map((field) => field.key)).not.toContain('_id')
  })

  it('категорий больше восьми — остальные в «прочее»; повторы схлопываются', () => {
    const values = Array.from({ length: 12 }, (_, i) => `v${i}`)
    const categories = categoriesFor([...values, 'v0'])
    expect(categories).toHaveLength(8)
    expect(categories.at(-1)).toEqual({ value: 'v7', color: 'categorical.8' })
  })
})

describe('границы по сводке сервера', () => {
  const values = [2, 4, 4, 4, 5, 5, 7, 9]

  it('совпадают с classify при тех же данных', () => {
    const sorted = [...values].sort((a, b) => a - b)
    const summary = { min: 2, max: 9, mean: 5, stddev: 2, minPositive: 2, sample: sorted }
    for (const method of ['equal', 'quantile', 'jenks', 'log', 'stddev'] as const) {
      expect(classifySummary(summary, method, 4)).toEqual(classify(values, method, 4))
    }
  })

  it('без выборки и моментов — равные интервалы; пустая сводка — нет границ', () => {
    expect(classifySummary({ min: 0, max: 100 }, 'quantile', 4)).toEqual([0, 25, 50, 75, 100])
    expect(classifySummary({ min: 0, max: 100 }, 'stddev', 4)).toEqual([0, 25, 50, 75, 100])
    expect(classifySummary({ min: Number.NaN, max: 1 }, 'equal', 4)).toEqual([])
    expect(classifySummary({ min: 3, max: 3 }, 'jenks', 4)).toEqual([3, 3])
  })

  it('выборка крупного слоя: края — точные минимум и максимум сводки', () => {
    const sample = [10, 20, 30, 40, 50, 60, 70, 80]
    const edges = classifySummary({ min: 1, max: 1000, sample }, 'quantile', 4)
    expect(edges[0]).toBe(1)
    expect(edges.at(-1)).toBe(1000)
    expect(edges.slice(1, -1)).toEqual(classify(sample, 'quantile', 4).slice(1, -1))
  })

  it('логарифм по наименьшему положительному', () => {
    expect(classifySummary({ min: -5, max: 1000, minPositive: 1 }, 'log', 3)).toEqual([
      -5, 10, 100, 1000,
    ])
  })
})
