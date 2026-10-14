import { describe, expect, it } from 'vitest'
import {
  calcAlias,
  compareAlias,
  type ExplorePlan,
  explorePipelineLosses,
  explorePlanMetric,
  explorePlanPipeline,
  explorePlanSpec,
  groupAlias,
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

  it('столбцы результата: разрез, четыре части каждой меры и расчёт от текущего периода', () => {
    const withCalc = { ...plan, measures: [{ agg: 'count' as const, calc: 'share' as const }] }
    expect(planColumns(withCalc)).toEqual([
      'district',
      'count_cur',
      'count_prev',
      'count_diff',
      'count_pct',
      'count_share',
    ])
  })

  it('расчёты при сравнении: окно над значением текущего периода после частей сравнения', () => {
    const withCalc: ExplorePlan = {
      ...plan,
      groups: [{ field: 'occurred_on', bucket: 'week' }],
      measures: [
        { agg: 'count', calc: 'rank' },
        { agg: 'sum', field: 'damage', calc: 'change' },
      ],
    }
    const spec = explorePlanSpec(DATASET, withCalc)
    expect(spec.steps.map((step) => step.type)).toEqual([
      'filter',
      'aggregate',
      'compute',
      'window',
      'compute',
    ])
    const window = spec.steps[3] as Extract<(typeof spec.steps)[number], { type: 'window' }>
    expect(window.fields).toEqual([
      { alias: 'count_rank', fn: 'rank', partitionBy: [], orderBy: ['count_cur desc'] },
      {
        alias: 'sum_damage_lag',
        fn: 'lag',
        field: 'sum_damage_cur',
        n: 1,
        partitionBy: [],
        orderBy: ['occurred_on_week'],
      },
    ])
    const change = spec.steps[4] as Extract<(typeof spec.steps)[number], { type: 'compute' }>
    expect(change.fields).toEqual([
      { name: 'sum_damage_change', expr: '"sum_damage_cur" - "sum_damage_lag"' },
    ])
    expect(planColumns(withCalc)).toEqual([
      'occurred_on_week',
      'count_cur',
      'count_prev',
      'count_diff',
      'count_pct',
      'count_rank',
      'sum_damage_cur',
      'sum_damage_prev',
      'sum_damage_diff',
      'sum_damage_pct',
      'sum_damage_lag',
      'sum_damage_change',
    ])
  })
})

describe('explorePlanSpec — уровень территории', () => {
  it('разрез по предку уровня: вычисляемое поле перед сводкой, столбец — поле_уровень', () => {
    const plan: ExplorePlan = {
      ...base,
      groups: [{ field: 'territory', level: 'region' }, { field: 'kind' }],
      measures: [{ agg: 'count' }],
    }
    const spec = explorePlanSpec(DATASET, plan)
    expect(spec.steps.map((step) => step.type)).toEqual(['compute', 'aggregate'])
    expect(spec.steps[0]).toEqual({
      type: 'compute',
      fields: [{ name: 'territory_region', expr: `territory_level("territory", 'region')` }],
    })
    const aggregate = spec.steps[1] as Extract<(typeof spec.steps)[number], { type: 'aggregate' }>
    expect(aggregate.groupBy).toEqual([{ field: 'territory_region' }, { field: 'kind' }])
    expect(planColumns(plan)).toEqual(['territory_region', 'kind', 'count'])
  })

  it('у разреза по дате уровень не действует; длинное имя укорачивается', () => {
    expect(groupAlias({ field: 'occurred_on', bucket: 'month', level: 'district' })).toBe(
      'occurred_on_month',
    )
    const long = groupAlias({ field: 'territory_of_the_incident_reported', level: 'jamoat' })
    expect(long.length).toBeLessThanOrEqual(32)
    expect(long.endsWith('_jamoat')).toBe(true)
  })
})

describe('explorePlanPipeline — исследование датасетом', () => {
  it('те же шаги, что у запроса, без окон, сортировки и лимита; идентификаторы шагов разные', () => {
    const plan: ExplorePlan = {
      filter: { field: 'kind', op: 'eq', value: 'flood' },
      groups: [{ field: 'territory', level: 'district' }],
      measures: [{ agg: 'sum', field: 'damage', calc: 'share' }],
      compare: {
        field: 'occurred_on',
        current: { from: '2026-09-01', to: '2026-09-30' },
        previous: { from: '2026-08-01', to: '2026-08-31' },
      },
      sort: { field: 'sum_damage_cur', dir: 'desc' },
      limit: 10,
    }
    const definition = explorePlanPipeline(DATASET, plan, 'Ущерб по районам')
    expect(definition.source).toEqual({ kind: 'dataset', id: DATASET })
    expect(definition.outputName).toBe('Ущерб по районам')
    expect(definition.steps.map((step) => `${step.id}:${step.type}`)).toEqual([
      'filter:filter',
      'filter-2:filter',
      'compute:compute',
      'aggregate:aggregate',
      'compute-2:compute',
    ])
    expect(definition.steps[4]).toMatchObject({
      fields: [
        { name: 'sum_damage_diff', expr: '"sum_damage_cur" - "sum_damage_prev"' },
        { name: 'sum_damage_pct', type: 'percent' },
      ],
    })
    expect(explorePipelineLosses(plan)).toEqual({ calcs: true, limit: true })
  })

  it('без сводки — отфильтрованная копия датасета', () => {
    const plan: ExplorePlan = {
      filter: { field: 'kind', op: 'eq', value: 'flood' },
      groups: [],
      measures: [],
      sort: null,
      limit: null,
    }
    expect(explorePlanPipeline(DATASET, plan, 'Паводки').steps).toEqual([
      {
        id: 'filter',
        disabled: false,
        type: 'filter',
        where: { field: 'kind', op: 'eq', value: 'flood' },
      },
    ])
    expect(explorePipelineLosses(plan)).toEqual({ calcs: false, limit: false })
  })
})

describe('explorePlanMetric — показатель из меры', () => {
  it('мера, условия плана, разрезы и поле сравнения — поле времени', () => {
    const plan: ExplorePlan = {
      ...base,
      filter: { field: 'kind', op: 'eq', value: 'flood' },
      groups: [
        { field: 'territory', level: 'region' },
        { field: 'occurred_on', bucket: 'month' },
      ],
      compare: {
        field: 'occurred_on',
        current: { from: '2026-09-01', to: '2026-09-30' },
        previous: { from: '2026-08-01', to: '2026-08-31' },
      },
    }
    expect(explorePlanMetric(plan, { agg: 'sum', field: 'damage', calc: 'share' })).toEqual({
      measure: { agg: 'sum', field: 'damage' },
      filter: { field: 'kind', op: 'eq', value: 'flood' },
      timeField: 'occurred_on',
      dimensions: ['territory', 'occurred_on'],
      period: { unit: 'month', from: 0, to: 0 },
      comparison: 'previous_period',
    })
    expect(
      explorePlanMetric(base, { agg: 'expr', expr: 'sum(damage) / count()' })?.measure,
    ).toEqual({ agg: 'expr', expr: 'sum(damage) / count()' })
  })

  it('без сравнения — поле времени из разреза или датасета; без него — за всё время', () => {
    const byMonth: ExplorePlan = { ...base, groups: [{ field: 'occurred_on', bucket: 'month' }] }
    expect(explorePlanMetric(byMonth, { agg: 'count' })).toMatchObject({
      timeField: 'occurred_on',
      period: { unit: 'month', from: 0, to: 0 },
      comparison: 'previous_period',
    })
    const byRegion: ExplorePlan = { ...base, groups: [{ field: 'territory' }] }
    expect(explorePlanMetric(byRegion, { agg: 'count' }, 'occurred_on')).toMatchObject({
      timeField: 'occurred_on',
    })
    expect(explorePlanMetric(byRegion, { agg: 'count' })).toMatchObject({
      timeField: null,
      period: null,
      comparison: 'none',
    })
  })

  it('первое, последнее и склейка строк показателю не подходят', () => {
    expect(explorePlanMetric(base, { agg: 'string_agg', field: 'kind' })).toBeNull()
    expect(explorePlanMetric(base, { agg: 'first', field: 'kind' })).toBeNull()
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
