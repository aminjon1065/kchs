import { ChoroplethParams, type DatasetField } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { choroplethQuery } from './choropleth.js'

const field = (key: string, type: DatasetField['type'], label: string): DatasetField =>
  ({
    id: '00000000-0000-4000-8000-000000000000',
    key,
    label: { ru: label, en: label.toUpperCase() },
    type,
    semantic: 'dimension',
    required: false,
    unique: false,
    indexed: false,
    sensitive: false,
    readOnly: false,
    nullable: true,
    order: 0,
  }) as DatasetField

const FIELDS: DatasetField[] = [
  field('name', 'text', 'Название'),
  field('capacity', 'integer', 'Вместимость'),
  { ...field('damage', 'money', 'Ущерб'), format: { precision: 2, currency: 'TJS' } },
  field('territory', 'territory', 'Территория'),
  field('place', 'geometry', 'Место'),
]

const DATASET = '0190a1b2-0000-7000-8000-000000000001'
const REGION = '0190a1b2-0000-7000-8000-000000000002'

const params = (input: Record<string, unknown>) =>
  ChoroplethParams.parse({
    datasetId: DATASET,
    join: 'geometry',
    field: 'place',
    level: 'district',
    measure: { agg: 'count' },
    ...input,
  })

describe('запрос хороплета', () => {
  it('точки в границах: присвоение района, сводка, все районы справочника', () => {
    const { query, fields } = choroplethQuery(params({}), FIELDS)
    expect(query.source).toEqual({ kind: 'dataset', id: DATASET, alias: 'd' })
    expect(query.steps.map((step) => step.type)).toEqual([
      'spatial',
      'aggregate',
      'join',
      'filter',
      'compute',
      'select',
      'sort',
    ])
    expect(query.steps[0]).toEqual({
      type: 'spatial',
      op: 'assign_territory',
      params: { field: 'd.place', level: 'district', as: 'choropleth_territory' },
    })
    expect(query.steps[2]).toEqual({
      type: 'join',
      kind: 'right',
      source: { kind: 'system', name: 'territories', alias: 't' },
      on: [{ left: 'choropleth_territory', right: 't.id' }],
    })
    // Территории без объектов — ноль, а не пусто
    expect(query.steps[4]).toEqual({
      type: 'compute',
      fields: [
        { name: 'choropleth_value', expr: 'coalesce(choropleth_measure, 0)', type: 'integer' },
      ],
    })
    const select = query.steps[5] as { fields: Array<{ alias: string }> }
    expect(select.fields.map((item) => item.alias)).toEqual([
      'territory',
      'code',
      'name',
      'value',
      'geom',
    ])
    expect(fields.value).toEqual({
      label: { ru: 'Количество', en: 'Count' },
      format: { precision: 0 },
    })
    expect(fields.territory?.label).toEqual({ ru: 'Район', en: 'District' })
  })

  it('поле территории: отбор по региону до сводки, уровень — territory_level', () => {
    const { query } = choroplethQuery(
      params({ join: 'territory', field: 'territory', withinId: REGION, level: 'district' }),
      FIELDS,
    )
    expect(query.steps.slice(0, 2)).toEqual([
      {
        type: 'filter',
        where: { field: 'd.territory', op: 'within', value: REGION },
      },
      {
        type: 'compute',
        fields: [
          { name: 'choropleth_territory', expr: "territory_level(d.territory, 'district')" },
        ],
      },
    ])
    expect(query.steps[4]).toEqual({
      type: 'filter',
      where: {
        and: [
          { field: 't.level', op: 'eq', value: 'district' },
          { field: 't.geom', op: 'not_empty' },
          { field: 't.id', op: 'within', value: REGION },
        ],
      },
    })
  })

  it('нормализация на население: доля на 1 000 жителей и подписи', () => {
    const { query, fields } = choroplethQuery(
      params({ normalize: 'population', per: 1000, measure: { agg: 'sum', field: 'capacity' } }),
      FIELDS,
    )
    const compute = query.steps.find((step) => step.type === 'compute') as {
      fields: Array<{ name: string; expr: string; type?: string }>
    }
    expect(compute.fields).toEqual([
      { name: 'choropleth_value', expr: 'coalesce(choropleth_measure, 0)', type: 'integer' },
      {
        name: 'choropleth_rate',
        expr: 'safe_div(choropleth_value, t.population) * 1000',
        type: 'number',
      },
    ])
    const aggregate = query.steps.find((step) => step.type === 'aggregate')
    expect(aggregate).toMatchObject({
      measures: [{ alias: 'choropleth_measure', agg: 'sum', field: 'd.capacity' }],
    })
    const select = query.steps.find((step) => step.type === 'select') as {
      fields: Array<{ alias: string }>
    }
    expect(select.fields.map((item) => item.alias)).toEqual([
      'territory',
      'code',
      'name',
      'value',
      'population',
      'rate',
      'geom',
    ])
    const thousand = new Intl.NumberFormat('ru-RU').format(1000)
    expect(fields.value?.label).toEqual({ ru: 'Сумма: Вместимость', en: 'Sum: ВМЕСТИМОСТЬ' })
    expect(fields.rate?.label.ru).toBe(`Сумма: Вместимость на ${thousand} жителей`)
    expect(fields.rate?.label.en).toBe('Sum: ВМЕСТИМОСТЬ per 1,000 residents')
    expect(fields.rate?.format).toBeNull()
  })

  it('нормализация на площадь и формат суммы денег — как у поля', () => {
    const { query, fields } = choroplethQuery(
      params({ normalize: 'area', per: 100, measure: { agg: 'sum', field: 'damage' } }),
      FIELDS,
    )
    const compute = query.steps.find((step) => step.type === 'compute') as {
      fields: Array<{ expr: string; type?: string }>
    }
    expect(compute.fields[0]?.type).toBe('money')
    expect(compute.fields[1]?.expr).toBe('safe_div(choropleth_value, t.area_km2) * 100')
    expect(fields.value?.format).toEqual({ precision: 2, currency: 'TJS' })
    expect(fields.area_km2?.label.ru).toBe('Площадь, км²')
    expect(fields.rate?.label.ru).toBe('Сумма: Ущерб на 100 км²')
  })

  it('среднее — без нуля для пустых территорий', () => {
    const { query, fields } = choroplethQuery(
      params({ measure: { agg: 'avg', field: 'capacity' } }),
      FIELDS,
    )
    const compute = query.steps.find((step) => step.type === 'compute') as {
      fields: Array<{ expr: string; type?: string }>
    }
    expect(compute.fields[0]).toMatchObject({ expr: 'choropleth_measure', type: 'number' })
    expect(fields.value?.format).toEqual({ precision: 2 })
  })

  it('поля проверяются по схеме источника', () => {
    expect(() => choroplethQuery(params({ field: 'territory' }), FIELDS)).toThrow(
      'В датасете нет поля геометрии «territory»',
    )
    expect(() => choroplethQuery(params({ join: 'territory', field: 'place' }), FIELDS)).toThrow(
      'В датасете нет поля территории «place»',
    )
    expect(() =>
      choroplethQuery(params({ measure: { agg: 'sum', field: 'name' } }), FIELDS),
    ).toThrow('Мера считается по числовому полю, а «name» — нет')
  })

  it('контракт: мера и нормализация согласованы', () => {
    const invalid = (input: Record<string, unknown>) =>
      ChoroplethParams.safeParse({
        datasetId: DATASET,
        join: 'geometry',
        field: 'place',
        level: 'district',
        ...input,
      }).success
    expect(invalid({ measure: { agg: 'sum' } })).toBe(false)
    expect(invalid({ measure: { agg: 'count', field: 'capacity' } })).toBe(false)
    expect(invalid({ measure: { agg: 'avg', field: 'capacity' }, normalize: 'area' })).toBe(false)
    expect(invalid({ measure: { agg: 'count' }, normalize: 'population', per: 1000 })).toBe(true)
  })
})
