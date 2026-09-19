import { ChoroplethParams, type DatasetField, type DatasetRecord } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  choroplethParams,
  choroplethReady,
  initialForm,
  stepReady,
  withDataset,
  withMeasure,
  withNormalize,
} from './choropleth-form.js'
import { featuresBbox, numericValues, resultFeatures } from './geojson.js'

const field = (key: string, type: DatasetField['type']): DatasetField =>
  ({
    id: '00000000-0000-4000-8000-000000000000',
    key,
    label: { ru: key },
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

const dataset = (fields: DatasetField[], territoryField: string | null = null) =>
  ({
    id: '0190a1b2-0000-7000-8000-000000000001',
    name: 'Объекты',
    fields,
    territoryField,
  }) as unknown as DatasetRecord

describe('форма хороплет-мастера', () => {
  it('связь по умолчанию: поле территории датасета, иначе геометрия', () => {
    const both = dataset(
      [field('place', 'geometry'), field('district', 'territory'), field('region', 'territory')],
      'region',
    )
    expect(initialForm(both)).toMatchObject({ join: 'territory', field: 'region' })
    const points = dataset([field('place', 'geometry'), field('capacity', 'integer')])
    expect(initialForm(points)).toMatchObject({ join: 'geometry', field: 'place' })
    expect(choroplethReady(dataset([field('name', 'text')]))).toBe(false)
  })

  it('мера и нормализация: среднее без нормализации, множитель — по основе', () => {
    const numeric = [field('capacity', 'integer')]
    const form = initialForm(dataset([field('place', 'geometry'), ...numeric]))
    expect(form).toMatchObject({ agg: 'count', normalize: 'population', per: 1000 })
    const avg = withMeasure(form, 'avg', numeric)
    expect(avg).toMatchObject({ agg: 'avg', measureField: 'capacity', normalize: 'none' })
    expect(withNormalize(form, 'area').per).toBe(1)
    expect(withNormalize(withNormalize(form, 'area'), 'population').per).toBe(1000)
    expect(withMeasure(avg, 'count', numeric).measureField).toBeNull()
  })

  it('параметры проходят контракт; незаполненная форма — null', () => {
    const points = dataset([field('place', 'geometry'), field('capacity', 'integer')])
    const form = initialForm(points)
    const params = choroplethParams(form)
    expect(ChoroplethParams.safeParse(params).success).toBe(true)
    expect(params).toMatchObject({
      join: 'geometry',
      field: 'place',
      measure: { agg: 'count', field: null },
      normalize: 'population',
      per: 1000,
      style: { method: 'jenks', classes: 5, palette: { name: 'blue', reverse: false } },
    })
    expect(choroplethParams({ ...form, agg: 'sum', measureField: null })).toBeNull()
    expect(stepReady('measure', { ...form, agg: 'sum', measureField: null })).toBe(false)
    expect(choroplethParams({ ...form, normalize: 'none', per: 1000 })?.per).toBe(1)

    const other = dataset([field('territory', 'territory')], 'territory')
    expect(withDataset(form, { ...other, id: 'x' } as DatasetRecord)).toMatchObject({
      datasetId: 'x',
      join: 'territory',
      field: 'territory',
    })
  })
})

describe('GeoJSON из результата запроса', () => {
  const result = {
    fields: [
      { name: 'code', type: 'identifier', semantic: null, label: null, format: null },
      { name: 'value', type: 'integer', semantic: null, label: null, format: null },
      { name: 'geom', type: 'geometry', semantic: null, label: null, format: null },
    ],
    rows: [
      [
        'A',
        3,
        {
          type: 'Polygon',
          coordinates: [
            [
              [68, 38],
              [69, 38],
              [69, 39],
              [68, 38],
            ],
          ],
        },
      ],
      ['B', null, { type: 'Point', coordinates: [70, 37.5] }],
      ['C', 5, null],
    ],
    rowCount: 3,
    approx: false,
    truncated: false,
    durationMs: 1,
    cached: false,
  } as const

  it('объекты без геометрии пропускаются, свойства — остальные поля', () => {
    const features = resultFeatures(result as never, 'geom')
    expect(features.features.map((feature) => feature.properties)).toEqual([
      { code: 'A', value: 3 },
      { code: 'B', value: null },
    ])
    expect(featuresBbox(features)).toEqual([68, 37.5, 70, 39])
    expect(numericValues(features, 'value')).toEqual([3])
    expect(featuresBbox({ type: 'FeatureCollection', features: [] })).toBeNull()
  })
})
