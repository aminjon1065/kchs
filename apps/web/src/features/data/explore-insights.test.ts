import type { DatasetField } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  categoryFieldsOf,
  comparePeriods,
  exploreQuestions,
  fieldQuestionPlan,
  groupValueFilter,
  presetOf,
  smartPlan,
} from './explore-insights.js'

/**
 * Подсказки «Исследования» (ADR-0217): старт по схеме, готовые вопросы, периоды
 * сравнения у конца данных и условия детализации.
 */
let id = 0
function field(key: string, type: DatasetField['type'], extra: Partial<DatasetField> = {}) {
  id += 1
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    key,
    label: { ru: key },
    type,
    semantic: 'dimension',
    required: false,
    ...extra,
  } as DatasetField
}

const incidents = {
  fields: [
    field('_id', 'integer', { semantic: 'system' }),
    field('kind', 'select'),
    field('district', 'territory'),
    field('occurred_on', 'date'),
    field('victims', 'integer', { semantic: 'measure' }),
  ],
  timeField: 'occurred_on',
  territoryField: 'district',
}
const label = (item: DatasetField) => item.label.ru ?? item.key

describe('умный старт', () => {
  it('есть дата — количество по месяцам по порядку времени', () => {
    expect(smartPlan(incidents)).toMatchObject({
      groups: [{ field: 'occurred_on', bucket: 'month' }],
      measures: [{ agg: 'count' }],
      sort: { field: 'occurred_on_month', dir: 'asc' },
    })
  })

  it('без даты — территория, топ-20 по убыванию; без полей — количество', () => {
    const noTime = {
      ...incidents,
      fields: incidents.fields.filter((f) => f.type !== 'date'),
      timeField: null,
    }
    expect(smartPlan(noTime)).toMatchObject({ groups: [{ field: 'district' }], limit: 20 })
    expect(smartPlan({ fields: [], timeField: null, territoryField: null }).groups).toEqual([])
  })
})

describe('категории для разреза', () => {
  it('не идентификатор и не ключ строки; размеченные категорией — первыми', () => {
    const fields = [
      field('code', 'identifier'),
      field('number', 'text'),
      field('note', 'text'),
      field('kind', 'text', { semantic: 'category' }),
    ]
    const keys = categoryFieldsOf({
      fields,
      timeField: null,
      territoryField: null,
      primaryKey: ['number'],
    }).map((item) => item.key)
    expect(keys).toEqual(['kind', 'note'])
  })
})

describe('готовые вопросы', () => {
  it('динамика, топ, районы, карта, сравнение и показатель — из схемы', () => {
    const questions = exploreQuestions(incidents, label, '2026-09-18')
    expect(questions.map((q) => q.id)).toEqual([
      'trend',
      'top:kind',
      'territory',
      'map',
      'compare',
      'sum:victims',
    ])
    const compare = questions.find((q) => q.id === 'compare')
    // Год в данных ещё не закончился — сравнивается последний полный год с предыдущим
    expect(compare?.plan.compare).toEqual({
      field: 'occurred_on',
      current: { from: '2025-01-01', to: '2025-12-31' },
      previous: { from: '2024-01-01', to: '2024-12-31' },
    })
    expect(questions.find((q) => q.id === 'map')?.view).toBe('map')
  })

  it('карточка числового поля — сумма и среднее по месяцам', () => {
    const victims = incidents.fields.find((f) => f.key === 'victims') as DatasetField
    expect(fieldQuestionPlan(incidents, victims).measures).toEqual([
      { agg: 'sum', field: 'victims' },
      { agg: 'avg', field: 'victims' },
    ])
  })
})

describe('периоды сравнения', () => {
  it('месяц: последний полный месяц к предыдущему, через границу года', () => {
    expect(comparePeriods('month', '2026-01-15')).toEqual({
      current: { from: '2025-12-01', to: '2025-12-31' },
      previous: { from: '2025-11-01', to: '2025-11-30' },
    })
    expect(comparePeriods('month', '2026-03-31').current).toEqual({
      from: '2026-03-01',
      to: '2026-03-31',
    })
  })

  it('квартал и «с начала года»', () => {
    expect(comparePeriods('quarter', '2026-05-10')).toEqual({
      current: { from: '2026-01-01', to: '2026-03-31' },
      previous: { from: '2025-10-01', to: '2025-12-31' },
    })
    expect(comparePeriods('ytd', '2024-02-29')).toEqual({
      current: { from: '2024-01-01', to: '2024-02-29' },
      previous: { from: '2023-01-01', to: '2023-02-28' },
    })
  })

  it('пресет узнаётся по периодам; свои даты — «произвольно»', () => {
    const periods = comparePeriods('quarter', '2026-09-30')
    expect(presetOf({ field: 'd', ...periods }, '2026-09-30')).toBe('quarter')
    expect(
      presetOf(
        {
          field: 'd',
          current: { from: '2026-01-05', to: '2026-01-06' },
          previous: { from: '2026-01-01', to: '2026-01-02' },
        },
        '2026-09-30',
      ),
    ).toBe('custom')
  })
})

describe('детализация', () => {
  it('месяц — диапазоном, территория — внутри с вложенными, пусто — «не задано»', () => {
    expect(
      groupValueFilter(
        { field: 'occurred_on', bucket: 'month' },
        undefined,
        '2026-02-01T00:00:00Z',
      ),
    ).toEqual({
      and: [
        { field: 'occurred_on', op: 'gte', value: '2026-02-01T00:00:00.000Z' },
        { field: 'occurred_on', op: 'lt', value: '2026-03-01T00:00:00.000Z' },
      ],
    })
    const district = incidents.fields.find((f) => f.key === 'district')
    expect(groupValueFilter({ field: 'district' }, district, 'T-1')).toEqual({
      field: 'district',
      op: 'within',
      value: { id: 'T-1', includeChildren: true },
    })
    expect(groupValueFilter({ field: 'kind' }, undefined, null)).toEqual({
      field: 'kind',
      op: 'is_empty',
    })
  })
})
