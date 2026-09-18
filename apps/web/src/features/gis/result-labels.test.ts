import type { QueryResult } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { optionLabels, relabelResult, unlabelPick } from './result-labels.js'

const result: QueryResult = {
  fields: [
    { name: 'region', type: 'territory', semantic: 'territory', label: null, format: null },
    { name: 'kind', type: 'text', semantic: 'category', label: null, format: null },
    { name: 'n', type: 'integer', semantic: 'measure', label: null, format: null },
  ],
  rows: [
    ['id-kt', 'FL', 3],
    ['id-su', 'XX', 1],
    [null, 'FL', 2],
  ],
  rowCount: 3,
  approx: false,
  truncated: false,
  durationMs: 1,
  cached: false,
}

describe('подписи в результате запроса', () => {
  it('значения столбцов заменяются подписями; без подписи и пустые — как есть', () => {
    const labels = new Map([
      ['region', new Map([['id-kt', 'Хатлонская область']])],
      ['kind', optionLabels([{ value: 'FL', label: { ru: 'Паводок', en: 'Flood' } }], 'en')],
    ])
    expect(relabelResult(result, labels).rows).toEqual([
      ['Хатлонская область', 'Flood', 3],
      ['id-su', 'XX', 1],
      [null, 'Flood', 2],
    ])
    // Исходный результат не меняется
    expect(result.rows[0]).toEqual(['id-kt', 'FL', 3])
  })

  it('нет подписей — тот же объект результата', () => {
    expect(relabelResult(result, new Map())).toBe(result)
  })

  it('выбранный элемент подписанного графика — обратно к значениям для детализации', () => {
    const labelled = relabelResult(
      result,
      new Map([['region', new Map([['id-kt', 'Хатлонская область']])]]),
    )
    const pick = {
      label: 'Хатлонская область · FL',
      filters: [
        { field: 'region', op: 'eq' as const, value: 'Хатлонская область' },
        { field: 'kind', op: 'eq' as const, value: 'FL' },
        { field: 'region', op: 'in' as const, value: ['Хатлонская область', 'id-su'] },
      ],
    }
    expect(unlabelPick(pick, result, labelled).filters).toEqual([
      { field: 'region', op: 'eq', value: 'id-kt' },
      { field: 'kind', op: 'eq', value: 'FL' },
      { field: 'region', op: 'in', value: ['id-kt', 'id-su'] },
    ])
    expect(unlabelPick(pick, result, result)).toBe(pick)
  })
})
