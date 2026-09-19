import { type ChartSpec, ChartSpec as ChartSpecSchema } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { brushFilter, brushLabel, bucketLastDay, nextHour } from './brush-filter.js'

const DATASET = '00000000-0000-4000-8000-000000000001'
const fields = [{ key: 'occurred_at' }, { key: 'kind' }, { key: 'damage' }]

function chart(steps: unknown[]): ChartSpec {
  return ChartSpecSchema.parse({
    version: 1,
    type: 'bar',
    data: { query: { version: 1, source: { kind: 'dataset', id: DATASET }, steps } },
    encoding: {
      x: { field: 'occurred_at_month', type: 'temporal' },
      y: [{ field: 'n', type: 'quantitative' }],
    },
  })
}

const byMonth = chart([
  {
    type: 'aggregate',
    groupBy: [{ field: 'occurred_at', bucket: 'month' }],
    measures: [{ agg: 'count', alias: 'n' }],
  },
])

describe('кисть графика → условие строк датасета', () => {
  it('месяцы: от начала первого до последнего дня последнего', () => {
    expect(
      brushFilter(
        byMonth,
        { field: 'occurred_at_month', op: 'between', value: ['2026-03-01', '2026-05-01'] },
        fields,
      ),
    ).toEqual({ field: 'occurred_at', op: 'between', value: ['2026-03-01', '2026-05-31'] })
  })

  it('часы — полуоткрытый интервал моментов', () => {
    const hourly = chart([
      {
        type: 'aggregate',
        groupBy: [{ field: 'occurred_at', bucket: 'hour', alias: 'hour' }],
        measures: [{ agg: 'count', alias: 'n' }],
      },
    ])
    expect(
      brushFilter(
        hourly,
        { field: 'hour', op: 'between', value: ['2026-03-01T10:00:00', '2026-03-01T12:00:00'] },
        fields,
      ),
    ).toEqual({
      and: [
        { field: 'occurred_at', op: 'gte', value: '2026-03-01T10:00:00' },
        { field: 'occurred_at', op: 'lt', value: '2026-03-01T13:00:00' },
      ],
    })
  })

  it('категории — список значений поля; меры и чужие поля — нет условия', () => {
    const byKind = chart([
      {
        type: 'aggregate',
        groupBy: [{ field: 'kind' }],
        measures: [{ agg: 'sum', field: 'damage', alias: 'total' }],
      },
    ])
    expect(
      brushFilter(byKind, { field: 'kind', op: 'in', value: ['fire', 'flood'] }, fields),
    ).toEqual({ field: 'kind', op: 'in', value: ['fire', 'flood'] })
    expect(brushFilter(byKind, { field: 'total', op: 'between', value: [1, 5] }, fields)).toBeNull()
    expect(
      brushFilter(byKind, { field: 'kind', op: 'in', value: ['fire'] }, [{ key: 'other' }]),
    ).toBeNull()
  })

  it('без агрегации — поле датасета как есть; график по показателю — нет условия', () => {
    const raw = chart([{ type: 'select', fields: ['damage', 'occurred_at'] }])
    expect(brushFilter(raw, { field: 'damage', op: 'between', value: [10, 20] }, fields)).toEqual({
      field: 'damage',
      op: 'between',
      value: [10, 20],
    })
    const metric = { ...byMonth, data: { metricId: DATASET } } as ChartSpec
    expect(
      brushFilter(metric, { field: 'occurred_at_month', op: 'between', value: ['a', 'b'] }, fields),
    ).toBeNull()
  })

  it('концы интервалов времени', () => {
    expect(bucketLastDay('2026-02-01', 'month')).toBe('2026-02-28')
    expect(bucketLastDay('2024-02-01', 'month')).toBe('2024-02-29')
    expect(bucketLastDay('2026-04-01', 'quarter')).toBe('2026-06-30')
    expect(bucketLastDay('2026-01-01', 'year')).toBe('2026-12-31')
    expect(bucketLastDay('2026-03-30', 'week')).toBe('2026-04-05')
    expect(bucketLastDay('2026-03-30T00:00:00', 'day')).toBe('2026-03-30')
    expect(bucketLastDay('март', 'day')).toBeNull()
    expect(nextHour('2026-03-01T23:00:00')).toBe('2026-03-02T00:00:00')
    expect(nextHour('2026-03-01T23:00:00+05:00')).toBe('2026-03-01T19:00:00.000Z')
  })

  it('подпись условия для чипа', () => {
    expect(
      brushLabel(
        { field: 'occurred_at', op: 'between', value: ['2026-03-01', '2026-05-31'] },
        'Дата',
        'ru',
      ),
    ).toBe('Дата: 01.03.2026 – 31.05.2026')
    expect(brushLabel({ field: 'kind', op: 'in', value: ['a', 'b', 'c', 'd'] }, 'Вид', 'ru')).toBe(
      'Вид: a, b, c, …',
    )
  })
})
