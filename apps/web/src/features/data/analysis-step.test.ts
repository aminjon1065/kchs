import { describe, expect, it } from 'vitest'
import { type AnalysisForm, analysisStep } from './analysis-step.js'

const DATASET = '11111111-1111-4111-8111-111111111111'
const TERRITORY = '22222222-2222-4222-8222-222222222222'

const form = (overrides: Partial<AnalysisForm>): AnalysisForm => ({
  op: 'buffer',
  field: null,
  distance: '500',
  size: '1000',
  limit: '1',
  maxDistance: '',
  inside: false,
  negate: false,
  level: 'district',
  by: null,
  target: { kind: 'dataset', id: null, hasGeometry: false },
  ...overrides,
})

describe('шаг spatial из формы анализа', () => {
  it('буфер: расстояние в метрах, запятая — десятичный разделитель', () => {
    expect(analysisStep(form({ distance: '250,5' }))).toEqual({
      type: 'spatial',
      op: 'buffer',
      params: { distance: 250.5 },
    })
    expect(analysisStep(form({ distance: '0' }))).toBeNull()
    expect(analysisStep(form({ distance: 'сто' }))).toBeNull()
  })

  it('поле геометрии — только если их несколько', () => {
    expect(analysisStep(form({ op: 'area', field: 'geom' }))?.params).toEqual({ field: 'geom' })
    expect(analysisStep(form({ op: 'area' }))?.params).toEqual({})
  })

  it('цель — датасет с геометрией или территории', () => {
    const intersects = form({ op: 'intersects', negate: true })
    expect(analysisStep(intersects)).toBeNull()
    expect(
      analysisStep({ ...intersects, target: { kind: 'dataset', id: DATASET, hasGeometry: false } }),
    ).toBeNull()
    expect(
      analysisStep({ ...intersects, target: { kind: 'dataset', id: DATASET, hasGeometry: true } }),
    ).toEqual({
      type: 'spatial',
      op: 'intersects',
      params: { negate: true },
      target: { kind: 'dataset', id: DATASET, alias: 't' },
    })
    expect(
      analysisStep({ ...intersects, target: { kind: 'territory', id: TERRITORY, level: 'region' } })
        ?.target,
    ).toEqual({ kind: 'territory', id: TERRITORY })
    expect(
      analysisStep({ ...intersects, target: { kind: 'territory', id: null, level: 'region' } })
        ?.target,
    ).toEqual({ kind: 'territory', level: 'region' })
  })

  it('ближайший: число и необязательный предел расстояния', () => {
    const target = { kind: 'dataset', id: DATASET, hasGeometry: true } as const
    expect(analysisStep(form({ op: 'nearest', limit: '3', target }))?.params).toEqual({ limit: 3 })
    expect(
      analysisStep(form({ op: 'nearest', limit: '1', maxDistance: '5000', target }))?.params,
    ).toEqual({ limit: 1, maxDistance: 5000 })
    expect(analysisStep(form({ op: 'nearest', limit: '1.5', target }))).toBeNull()
    expect(analysisStep(form({ op: 'nearest', maxDistance: '-1', target }))).toBeNull()
  })

  it('сетки, территория, растворение, центроид', () => {
    expect(analysisStep(form({ op: 'hexgrid', size: '5' }))).toBeNull()
    expect(analysisStep(form({ op: 'grid', size: '2000' }))?.params).toEqual({ size: 2000 })
    expect(analysisStep(form({ op: 'assign_territory', level: 'jamoat' }))?.params).toEqual({
      level: 'jamoat',
    })
    expect(analysisStep(form({ op: 'dissolve', by: 'kind' }))?.params).toEqual({ by: ['kind'] })
    expect(analysisStep(form({ op: 'dissolve' }))?.params).toEqual({})
    expect(analysisStep(form({ op: 'centroid', inside: true }))?.params).toEqual({ inside: true })
  })
})
