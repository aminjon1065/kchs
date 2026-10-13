import { describe, expect, it } from 'vitest'
import {
  calcAlias,
  compareAlias,
  type ExplorePlan,
  explorePlanSpec,
  measureAlias,
  periodWhere,
  planColumns,
} from '../explore.js'

/**
 * План «Исследования» (ADR-0217): сравнение двух периодов и расчёты над мерами —
 * одна функция плана для клиента и сервера, столбцы результата известны заранее.
 */
const DATASET = '11111111-1111-4111-8111-111111111111'

const base: ExplorePlan = {
  filter: null,
  groups: [{ field: 'district' }],
  measures: [{ agg: 'count' }, { agg: 'sum', field: 'damage' }],
  sort: null,
  limit: null,
}

describe('explorePlanSpec — сравнение периодов', () => {
  const plan: ExplorePlan = {
    ...base,
    compare: {
      field: 'occurred_on',
      current: { from: '2026-09-01', to: '2026-09-30' },
      previous: { from: '2026-08-01', to: '2026-08-31' },
    },
  }

  it('условные меры по периодам, разница и изменение в процентах', () => {
    const spec = explorePlanSpec(DATASET, plan)
    expect(spec.steps.map((step) => step.type)).toEqual(['filter', 'aggregate', 'compute'])
    const aggregate = spec.steps[1] as Extract<(typeof spec.steps)[number], { type: 'aggregate' }>
    expect(aggregate.measures.map((measure) => measure.alias)).toEqual([
      'count_cur',
      'count_prev',
      'sum_damage_cur',
      'sum_damage_prev',
    ])
    expect(aggregate.measures[0]?.filter).toEqual(
      periodWhere('occurred_on', { from: '2026-09-01', to: '2026-09-30' }),
    )
    const compute = spec.steps[2] as Extract<(typeof spec.steps)[number], { type: 'compute' }>
    expect(compute.fields).toContainEqual({
      name: 'count_pct',
      expr: '("count_cur" - "count_prev") / "count_prev"',
      type: 'percent',
    })
  })

  it('последний день периода входит целиком: граница — следующий день', () => {
    expect(periodWhere('d', { from: '2026-02-01', to: '2026-02-28' })).toEqual({
      and: [
        { field: 'd', op: 'gte', value: '2026-02-01' },
        { field: 'd', op: 'lt', value: '2026-03-01' },
      ],
    })
  })

  it('столбцы результата: разрез и четыре части каждой меры; расчёты не применяются', () => {
    const withCalc = { ...plan, measures: [{ agg: 'count' as const, calc: 'share' as const }] }
    expect(planColumns(withCalc)).toEqual([
      'district',
      'count_cur',
      'count_prev',
      'count_diff',
      'count_pct',
    ])
  })
})

describe('explorePlanSpec — расчёты над мерами', () => {
  it('доля и ранг — окно по всему результату, изменение — lag и вычисление', () => {
    const plan: ExplorePlan = {
      ...base,
      groups: [{ field: 'occurred_on', bucket: 'month' }],
      measures: [
        { agg: 'count', calc: 'share' },
        { agg: 'sum', field: 'damage', calc: 'change_pct' },
      ],
    }
    const spec = explorePlanSpec(DATASET, plan)
    expect(spec.steps.map((step) => step.type)).toEqual(['aggregate', 'window', 'compute'])
    const window = spec.steps[1] as Extract<(typeof spec.steps)[number], { type: 'window' }>
    expect(window.fields).toEqual([
      { alias: 'count_share', fn: 'share', field: 'count', partitionBy: [], orderBy: [] },
      {
        alias: 'sum_damage_lag',
        fn: 'lag',
        field: 'sum_damage',
        n: 1,
        partitionBy: [],
        orderBy: ['occurred_on_month'],
      },
    ])
    expect(planColumns(plan)).toEqual([
      'occurred_on_month',
      'count',
      'count_share',
      'sum_damage',
      'sum_damage_lag',
      'sum_damage_change_pct',
    ])
  })

  it('накопительный итог без разреза не считается — нет порядка строк', () => {
    const plan: ExplorePlan = { ...base, groups: [], measures: [{ agg: 'count', calc: 'running' }] }
    expect(explorePlanSpec(DATASET, plan).steps.map((step) => step.type)).toEqual(['aggregate'])
    expect(planColumns(plan)).toEqual(['count'])
  })

  it('длинное имя столбца укорачивается до 32 символов с отпечатком', () => {
    const measure = { agg: 'count_distinct' as const, field: 'very_long_field_name_of_dataset' }
    const share = calcAlias({ ...measure, calc: 'share' })
    expect(share.length).toBeLessThanOrEqual(32)
    expect(share.endsWith('_share')).toBe(true)
    expect(compareAlias(measure, 'pct')).not.toBe(compareAlias(measure, 'diff'))
    expect(measureAlias(measure)).toBe('count_distinct_very_long_field_name_of_dataset')
  })
})
