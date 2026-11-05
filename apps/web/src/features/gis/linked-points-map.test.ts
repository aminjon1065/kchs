import type { QueryResult } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { linkedFeatures, linkedPointsSpec } from './linked-points-map.js'

describe('карта рядом с таблицей', () => {
  it('запрос — под фильтром таблицы, только строки с местом, идентификатор и место', () => {
    const where = { field: 'type_code', op: 'eq' as const, value: 'MUDFLOW' }
    const spec = linkedPointsSpec('ds-1', 'geometry', where)
    expect(spec.source).toEqual({ kind: 'dataset', id: 'ds-1' })
    expect(spec.steps).toEqual([
      { type: 'filter', where },
      { type: 'filter', where: { field: 'geometry', op: 'not_empty' } },
      { type: 'select', fields: ['_id', 'geometry'] },
      { type: 'limit', limit: 5000, offset: 0 },
    ])
    // Без фильтра таблицы — без шага фильтра
    expect(linkedPointsSpec('ds-1', 'geometry', null).steps[0]).toEqual({
      type: 'filter',
      where: { field: 'geometry', op: 'not_empty' },
    })
  })

  it('строки → точки с идентификатором строки строкой, пустое место пропускается', () => {
    const result = {
      fields: [
        { name: '_id', type: 'integer', semantic: 'system', label: null, format: null },
        { name: 'geometry', type: 'geometry', semantic: 'geometry', label: null, format: null },
      ],
      rows: [
        [2, { type: 'Point', coordinates: [68.8, 38.3] }],
        [7, null],
      ],
      rowCount: 2,
      approx: false,
      truncated: false,
      durationMs: 1,
      cached: false,
      executedOn: 'postgres',
    } as unknown as QueryResult
    const collection = linkedFeatures(result, 'geometry')
    expect(collection.features).toHaveLength(1)
    expect(collection.features[0]?.properties).toEqual({ _id: '2' })
    expect(linkedFeatures(undefined, 'geometry').features).toEqual([])
  })
})
