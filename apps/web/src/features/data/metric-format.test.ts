import type { MetricValue } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  METRIC_PERIOD_PRESETS,
  metricTileModel,
  periodPreset,
  periodText,
  presetPeriod,
} from './metric-format.js'

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key} ${JSON.stringify(params)}` : key

const VALUE: MetricValue = {
  metricId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  name: 'Происшествия',
  unit: 'шт.',
  format: { precision: 0 },
  direction: 'down',
  period: { unit: 'month', from: 0, to: 0 },
  comparison: 'previous_period',
  window: null,
  baseWindow: null,
  value: 3,
  base: 1,
  delta: { absolute: 2, relative: 2, direction: 'up', good: false },
  target: 4,
  status: 'warning',
  series: [
    { period: '2026-01-01', value: 1 },
    { period: '2026-02-01', value: null },
    { period: '2026-03-01', value: 3 },
  ],
  breakdown: [],
}

describe('периоды показателя', () => {
  it('пресеты туда и обратно; остальное — «свой»', () => {
    for (const preset of METRIC_PERIOD_PRESETS) {
      expect(periodPreset(presetPeriod(preset))).toBe(preset)
    }
    expect(presetPeriod('last30')).toEqual({ unit: 'day', from: -29, to: 0 })
    expect(periodPreset({ unit: 'month', from: -1, to: -1 })).toBe('custom')
    expect(periodText({ unit: 'month', from: 0, to: 0 }, t, 'ru')).toBe('data.metric.periods.month')
    expect(periodText({ start: '2026-03-01', end: '2026-03-31' }, t, 'ru')).toBe(
      '01.03.2026 — 31.03.2026',
    )
  })

  it('частые относительные периоды — словами, а не отсчётом единиц', () => {
    expect(periodText({ unit: 'day', from: 0, to: 0 }, t, 'ru')).toBe('data.metric.periods.today')
    expect(periodText({ unit: 'day', from: -1, to: -1 }, t, 'ru')).toBe(
      'data.metric.previousUnit.day',
    )
    expect(periodText({ unit: 'day', from: -13, to: 0 }, t, 'ru')).toBe(
      'data.metric.lastUnits.day {"count":14}',
    )
    expect(periodText({ unit: 'month', from: -5, to: -2 }, t, 'ru')).toBe(
      'data.metric.periodRelative {"unit":"data.metric.units.month","from":-5,"to":-2}',
    )
  })
})

describe('модель плитки показателя', () => {
  it('значение, дельта со знаком, цель «меньше — лучше», искра без пустых', () => {
    const model = metricTileModel(VALUE, t, 'en')
    expect(model).toMatchObject({
      label: 'Происшествия',
      value: 3,
      formatted: '3',
      unit: 'шт.',
      status: 'warning',
      delta: {
        value: 2,
        formatted: '+200.0%',
        direction: 'up',
        good: false,
        label: 'data.metric.compareLabels.previous_period',
      },
      target: { value: 4, formatted: '4' },
      spark: [1, 3],
    })
    // Меньше — лучше: значение 3 при цели 4 — цель перевыполнена
    expect(model.target?.progress).toBeCloseTo(4 / 3)
  })

  it('без значения и без базы: прочерк, без дельты и цели; подпись плитки важнее имени', () => {
    const model = metricTileModel(
      { ...VALUE, value: null, delta: null, base: null },
      t,
      'en',
      'Моя плитка',
    )
    expect(model).toMatchObject({
      label: 'Моя плитка',
      formatted: 'data.metric.none',
      delta: null,
      target: null,
    })
  })

  it('миллионы — компактно, нулевая база — дельта в единицах', () => {
    const model = metricTileModel(
      {
        ...VALUE,
        value: 2_500_000,
        base: 0,
        delta: { absolute: 2_500_000, relative: null, direction: 'up', good: true },
      },
      t,
      'en',
    )
    expect(model.formatted).toBe('2.5M')
    expect(model.delta?.formatted).toBe('+2.5M')
  })
})
