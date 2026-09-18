import type { QuerySpec } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { drillSpec } from './drill.js'

const ID = '01890000-0000-7000-8000-000000000001'

const chart = (steps: QuerySpec['steps']): QuerySpec => ({
  version: 1,
  source: { kind: 'dataset', id: ID },
  steps,
  params: {},
  options: { cache: true, approxCount: true },
})

describe('детализация плитки до строк', () => {
  it('условия до агрегации сохраняются, разрез — условием по полю, сортировка и лимит строк', () => {
    const { spec, datasetId } = drillSpec(
      chart([
        { type: 'filter', where: { field: 'kind', op: 'eq', value: 'паводок' } },
        {
          type: 'aggregate',
          groupBy: [{ field: 'district' }],
          measures: [{ alias: 'n', agg: 'count' }],
        },
        { type: 'sort', by: [{ field: 'n', dir: 'desc' }] },
      ]),
      [
        { field: 'district', op: 'eq', value: 'Хатлон' },
        { field: 'n', op: 'eq', value: 2 },
      ],
      200,
    )
    expect(datasetId).toBe(ID)
    expect(spec.steps).toEqual([
      { type: 'filter', where: { field: 'kind', op: 'eq', value: 'паводок' } },
      { type: 'filter', where: { field: 'district', op: 'eq', value: 'Хатлон' } },
      { type: 'sort', by: [{ field: '_id', dir: 'asc' }] },
      { type: 'limit', limit: 200, offset: 0 },
    ])
  })

  it('интервал времени — тем же усечением, что у агрегации; пустое значение — «пусто»', () => {
    const { spec } = drillSpec(
      chart([
        {
          type: 'aggregate',
          groupBy: [
            { field: 'at', bucket: 'month' },
            { field: 'region', alias: 'r' },
          ],
          measures: [{ alias: 'n', agg: 'count' }],
        },
      ]),
      [
        { field: 'at_month', op: 'eq', value: '2026-03-01' },
        { field: 'r', op: 'eq', value: null },
      ],
      50,
    )
    expect(spec.steps.slice(0, 2)).toEqual([
      { type: 'compute', fields: [{ name: '__drill_0', expr: `date_trunc('month', date("at"))` }] },
      {
        type: 'filter',
        where: {
          and: [
            { field: '__drill_0', op: 'eq', value: '2026-03-01' },
            { field: 'region', op: 'is_empty' },
          ],
        },
      },
    ])
  })

  it('не датасет и соединения — понятная ошибка', () => {
    expect(() => drillSpec({ ...chart([]), source: { kind: 'query', id: ID } }, [], 10)).toThrow(
      'по датасету',
    )
    expect(() =>
      drillSpec(
        chart([
          {
            type: 'join',
            source: { kind: 'dataset', id: ID },
            on: [{ left: 'a', right: 'b' }],
            kind: 'left',
          },
        ]),
        [],
        10,
      ),
    ).toThrow('соединениями')
  })
})
