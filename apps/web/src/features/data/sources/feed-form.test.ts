import { FeedConfig } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  configFromDraft,
  datasetFields,
  draftFromConfig,
  draftProblems,
  emptyDraft,
  emptyMapping,
  keyFromPath,
  mappedFields,
  newFieldsFor,
  TAJIKISTAN_BBOX,
} from './feed-form.js'

/** Черновик ленты мастера (ADR-0132): настройка туда и обратно, поля нового датасета. */
describe('черновик ленты', () => {
  const usgs = FeedConfig.parse({
    url: 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson',
    format: 'geojson',
    mapping: [
      { field: 'event_id', value: { kind: 'path', path: 'id' } },
      { field: 'source', value: { kind: 'const', value: 'USGS' } },
      {
        field: 'occurred_at',
        value: { kind: 'path', path: 'properties.time', transform: 'epoch_ms' },
      },
    ],
    geometry: { kind: 'feature' },
    geometryField: 'geometry',
    territoryField: 'district',
    withinTerritory: true,
    bbox: TAJIKISTAN_BBOX,
    keyFields: ['event_id'],
  })

  it('настройка → черновик → настройка без потерь', () => {
    const draft = draftFromConfig(usgs, null)
    expect(draft.mapping.occurred_at).toMatchObject({ kind: 'path', transform: 'epoch_ms' })
    expect(FeedConfig.parse(configFromDraft(draft))).toEqual(usgs)
  })

  it('поле без источника или с пустым вводом не сопоставлено', () => {
    const draft = {
      ...emptyDraft(),
      url: 'https://example.org/feed.csv',
      format: 'csv' as const,
      mapping: {
        code: { ...emptyMapping(), kind: 'template' as const, template: '{latitude}_{longitude}' },
        note: { ...emptyMapping(), kind: 'const' as const, constant: '  ' },
        at: { ...emptyMapping(), kind: 'date_time' as const, date: 'acq_date', time: '' },
      },
      keyFields: ['code', 'note'],
    }
    expect(mappedFields(draft)).toEqual(['code'])
    const config = configFromDraft(draft)
    expect(config.mapping).toEqual([
      { field: 'code', value: { kind: 'template', template: '{latitude}_{longitude}' } },
    ])
    // Ключ — только из полей ленты
    expect(config.keyFields).toEqual(['code'])
  })

  it('без геометрии область, районы и поле геометрии не уходят', () => {
    const draft = {
      ...draftFromConfig(usgs, null),
      geometry: 'none' as const,
    }
    const config = configFromDraft(draft)
    expect(config).toMatchObject({
      geometry: null,
      bbox: null,
      withinTerritory: false,
      geometryField: null,
      territoryField: null,
    })
  })

  it('готовность: адрес, сопоставление, ключ, широта и долгота', () => {
    expect(draftProblems(emptyDraft())).toEqual(['url', 'mapping', 'key'])
    const draft = {
      ...draftFromConfig(usgs, null),
      geometry: 'latlon' as const,
      lat: 'latitude',
      lon: '',
    }
    expect(draftProblems(draft)).toEqual(['geometry'])
    expect(draftProblems(draftFromConfig(usgs, null))).toEqual([])
  })
})

describe('поля нового датасета', () => {
  it('ключ поля по пути: последняя часть, snake_case, без повторов', () => {
    expect(keyFromPath('properties.mag')).toBe('mag')
    expect(keyFromPath('properties.magType')).toBe('mag_type')
    expect(keyFromPath('geometry.coordinates.0')).toBe('coordinates')
    expect(keyFromPath('properties.url.report')).toBe('report')
    expect(keyFromPath('Время события')).toBe('field')
    expect(keyFromPath('properties.id', new Set(['id']))).toBe('id_2')
  })

  it('типы по значениям путей, геометрия и район — отдельными полями', () => {
    const fields = newFieldsFor([
      { path: 'id', type: 'text', sample: 'us1', filled: 10 },
      { path: 'properties.mag', type: 'number', sample: 4.7, filled: 10 },
      { path: 'properties.time', type: 'datetime', sample: 1, filled: 10 },
      { path: 'properties.geometry', type: 'object', sample: {}, filled: 1 },
    ])
    expect(fields.map((field) => [field.key, field.label, field.type])).toEqual([
      ['id', 'id', 'text'],
      ['mag', 'mag', 'number'],
      ['time', 'time', 'datetime'],
      // Имя geometry занято полем геометрии записи
      ['geometry_2', 'geometry', 'text'],
    ])
    const defs = datasetFields(fields, ['id'], {
      geometryField: 'geometry',
      territoryField: 'district',
    })
    expect(defs.map((field) => [field.key, field.type, field.required])).toEqual([
      ['id', 'text', true],
      ['mag', 'number', false],
      ['time', 'datetime', false],
      ['geometry_2', 'text', false],
      ['geometry', 'geometry', false],
      ['district', 'territory', false],
    ])
  })
})
