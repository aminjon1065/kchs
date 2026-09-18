import type { DashboardFilter, QuerySpec } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { applyDashboardFilters, filterCondition } from './dashboard-filters.js'

const filter = (id: string, kind: DashboardFilter['kind'], extra: Partial<DashboardFilter> = {}) =>
  ({ id, kind, label: { ru: id }, ...extra }) as DashboardFilter

const spec: QuerySpec = {
  version: 1,
  source: { kind: 'dataset', id: '0190f5a0-0000-7000-8000-000000000001' },
  steps: [
    {
      type: 'aggregate',
      groupBy: [{ field: 'district' }],
      measures: [{ alias: 'n', agg: 'count' }],
    },
  ],
  params: {},
  options: { cache: true, approxCount: true },
}

describe('фильтры дашборда', () => {
  it('условие по виду фильтра; пустое значение — без условия', () => {
    expect(filterCondition(filter('p', 'period'), 'day', ['2026-01-01', '2026-03-31'])).toEqual({
      field: 'day',
      op: 'between',
      value: ['2026-01-01', '2026-03-31'],
    })
    expect(
      filterCondition(filter('p', 'period'), 'day', { unit: 'month', from: -2, to: 0 }),
    ).toMatchObject({ op: 'relative' })
    expect(filterCondition(filter('s', 'select'), 'district', ['Согд', 'ГБАО'])).toMatchObject({
      op: 'in',
    })
    expect(filterCondition(filter('s', 'select'), 'district', 'Согд')).toMatchObject({ op: 'eq' })
    expect(filterCondition(filter('t', 'text'), 'code', 'П-')).toMatchObject({ op: 'contains' })
    expect(
      filterCondition(filter('r', 'territory'), 'place', { id: 'x', includeChildren: true }),
    ).toMatchObject({ op: 'within' })
    for (const empty of [null, undefined, '', []]) {
      expect(filterCondition(filter('s', 'select'), 'district', empty)).toBeNull()
    }
  })

  it('привязанные фильтры — шаг filter перед сводкой; значение по умолчанию', () => {
    const filters = [
      filter('district', 'select'),
      filter('period', 'period', { default: { unit: 'year', from: 0, to: 0 } }),
      filter('unbound', 'text'),
    ]
    const bound = applyDashboardFilters(
      spec,
      filters,
      { district: 'district', period: 'day' },
      { district: 'Согд', unbound: 'x' },
    )
    expect(bound.steps[0]).toEqual({
      type: 'filter',
      where: {
        and: [
          { field: 'district', op: 'eq', value: 'Согд' },
          { field: 'day', op: 'relative', value: { unit: 'year', from: 0, to: 0 } },
        ],
      },
    })
    expect(bound.steps[1]).toEqual(spec.steps[0])
    // Нет привязок — запрос не меняется
    expect(applyDashboardFilters(spec, filters, {}, { district: 'Согд' })).toBe(spec)
  })
})
