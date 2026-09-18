import type { ChartSpec, DashboardFilter, DashboardTile } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { crossFilterFor } from './dashboard-drill.js'

const spec = {
  version: 1,
  type: 'bar',
  data: {
    query: {
      version: 1,
      source: { kind: 'dataset', id: '01890000-0000-7000-8000-000000000001' },
      steps: [
        {
          type: 'aggregate',
          groupBy: [{ field: 'region' }, { field: 'at', bucket: 'month' }],
          measures: [{ alias: 'n', agg: 'count' }],
        },
      ],
      params: {},
      options: { cache: true, approxCount: true },
    },
  },
  encoding: {},
} as unknown as ChartSpec

const tile = {
  id: 't',
  kind: 'chart',
  filterBindings: { area: 'region' },
  x: 0,
  y: 0,
  w: 6,
  h: 4,
} as DashboardTile
const filters = [{ id: 'area', kind: 'select', label: { ru: 'Область' } }] as DashboardFilter[]

describe('перекрёстный фильтр из детализации', () => {
  it('значение разреза, к полю которого привязан фильтр дашборда', () => {
    const pick = {
      label: 'Хатлон',
      filters: [{ field: 'region', op: 'eq' as const, value: 'Хатлон' }],
    }
    expect(crossFilterFor(spec, tile, filters, pick)).toEqual({ filterId: 'area', value: 'Хатлон' })
  })

  it('интервал времени, мера и поле без привязки — фильтра нет', () => {
    const month = {
      label: 'март',
      filters: [{ field: 'at_month', op: 'eq' as const, value: '2026-03-01' }],
    }
    expect(crossFilterFor(spec, tile, filters, month)).toBeNull()
    const measure = { label: '3', filters: [{ field: 'n', op: 'eq' as const, value: 3 }] }
    expect(crossFilterFor(spec, tile, filters, measure)).toBeNull()
    const unbound = { ...tile, filterBindings: {} }
    const pick = { label: 'Согд', filters: [{ field: 'region', op: 'eq' as const, value: 'Согд' }] }
    expect(crossFilterFor(spec, unbound, filters, pick)).toBeNull()
  })
})
