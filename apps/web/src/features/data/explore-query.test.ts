import { describe, expect, it } from 'vitest'
import { emptyExplore, exploreSpec, measureAlias, RAW_LIMIT } from './explore-query.js'

const ID = '0190f5a0-0000-7000-8000-000000000001'

describe('исследование: QuerySpec из конструктора', () => {
  it('по умолчанию — количество строк одной сводкой, без лимита', () => {
    expect(exploreSpec(emptyExplore(ID)).steps).toEqual([
      { type: 'aggregate', groupBy: [], measures: [{ alias: 'count', agg: 'count' }] },
    ])
  })

  it('фильтр, разрезы с интервалом, меры без повторов, сортировка и лимит — по порядку', () => {
    const spec = exploreSpec({
      datasetId: ID,
      filter: { field: 'district', op: 'eq', value: 'Хатлон' },
      groups: [{ field: 'day', bucket: 'month' }, { field: 'district' }],
      measures: [
        { agg: 'sum', field: 'amount' },
        { agg: 'count' },
        { agg: 'sum', field: 'amount' },
      ],
      sort: { field: 'sum_amount', dir: 'desc' },
      limit: 10,
    })
    expect(spec.steps.map((step) => step.type)).toEqual(['filter', 'aggregate', 'sort', 'limit'])
    expect(spec.steps[1]).toEqual({
      type: 'aggregate',
      groupBy: [{ field: 'day', bucket: 'month' }, { field: 'district' }],
      measures: [
        { alias: 'sum_amount', agg: 'sum', field: 'amount' },
        { alias: 'count', agg: 'count' },
      ],
    })
    expect(spec.source).toEqual({ kind: 'dataset', id: ID })
  })

  it('без сводки — строки с ограничением, имя меры — латиницей', () => {
    const spec = exploreSpec({ ...emptyExplore(ID), measures: [] })
    expect(spec.steps).toEqual([{ type: 'limit', limit: RAW_LIMIT, offset: 0 }])
    expect(measureAlias({ agg: 'avg', field: 'amount' })).toBe('avg_amount')
  })
})
