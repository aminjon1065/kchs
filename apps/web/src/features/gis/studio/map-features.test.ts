import { LayerStyle } from '@kchs/contracts'
import type { MapInstance } from '@kchs/ui'
import { describe, expect, it } from 'vitest'
import { featureLabel } from './identify.js'
import { datasetRowIds, withDatasetSelection } from './linked-views.js'
import {
  allOf,
  encodeFilter,
  featuresQuery,
  layerIdOfSource,
  layerRowConditions,
  mergeRefs,
  pickableLayerIds,
  refsOfHits,
  rowIdsOf,
} from './map-features.js'

const style = (patch: Record<string, unknown> = {}) =>
  LayerStyle.parse({
    version: 1,
    geometry: 'point',
    renderer: { kind: 'simple' },
    ...patch,
  })

describe('объекты слоёв на карте', () => {
  it('слои данных для выборки — по роли стиля, без подписей и подсветки', () => {
    const map = {
      getStyle: () => ({
        layers: [
          { id: 'background' },
          { id: 'kchs-data:L1:point', metadata: { 'kchs:role': 'point' } },
          { id: 'kchs-data:L1:label', metadata: { 'kchs:role': 'label' } },
          { id: 'kchs-data:L1:selection-point', metadata: { 'kchs:role': 'selection' } },
          { id: 'kchs-data:L2:fill', metadata: { 'kchs:role': 'fill' } },
          { id: 'kchs-tool:measure-line' },
        ],
      }),
    } as unknown as MapInstance
    expect(pickableLayerIds(map)).toEqual(['kchs-data:L1:point', 'kchs-data:L2:fill'])
    expect(layerIdOfSource('kchs-data:layer-abc')).toBe('abc')
    expect(layerIdOfSource('openmaptiles')).toBeNull()
  })

  it('объекты рамки: без повторов на стыке тайлов, скопления — отдельно', () => {
    const { refs, clustered } = refsOfHits([
      { source: 'kchs-data:layer-A', id: 1, properties: {} },
      { source: 'kchs-data:layer-A', id: 1, properties: {} },
      { source: 'kchs-data:layer-A', id: 2, properties: { point_count: 1 } },
      { source: 'kchs-data:layer-B', id: 7, properties: { point_count: 12 } },
      { source: 'kchs-data:layer-B', id: null, properties: {} },
      { source: 'basemap', id: 3, properties: {} },
    ])
    expect(refs).toEqual([
      { layerId: 'A', rowId: '1' },
      { layerId: 'A', rowId: '2' },
    ])
    expect(clustered).toEqual(['B'])
  })

  it('выделение: замена или дополнение, без повторов, с пределом', () => {
    const current = [{ layerId: 'A', rowId: '1' }]
    const next = [
      { layerId: 'A', rowId: '1' },
      { layerId: 'A', rowId: '2' },
    ]
    expect(mergeRefs(current, next, false, 10)).toEqual(next)
    expect(mergeRefs(current, [{ layerId: 'B', rowId: '1' }], true, 10)).toEqual([
      { layerId: 'A', rowId: '1' },
      { layerId: 'B', rowId: '1' },
    ])
    expect(mergeRefs([], next, false, 1)).toEqual([{ layerId: 'A', rowId: '1' }])
    expect(rowIdsOf([...next, { layerId: 'B', rowId: '9' }], 'A')).toEqual(['1', '2'])
  })

  it('условия строк слоя — как у тайлов: фильтр слоя, фильтр карты, время', () => {
    const timed = {
      style: style({
        time: { field: 'day' },
        filter: { field: 'kind', op: 'eq', value: 'school' },
      }),
    }
    const conditions = layerRowConditions(timed, {
      filter: { field: 'district', op: 'eq', value: 'Хатлон' },
      time: { from: '2026-03-01', to: '2026-03-31' },
    })
    expect(conditions).toEqual([
      { field: 'kind', op: 'eq', value: 'school' },
      { field: 'district', op: 'eq', value: 'Хатлон' },
      { field: 'day', op: 'between', value: ['2026-03-01', '2026-03-31'] },
    ])
    // Время карты не действует на слой без поля времени
    expect(layerRowConditions({ style: style() }, { time: { from: 'a', to: 'b' } })).toEqual([])
    expect(allOf([])).toBeUndefined()
    expect(allOf(conditions.slice(0, 1))).toEqual(conditions[0])
    expect(allOf(conditions)).toEqual({ and: conditions })
  })

  it('параметры объектов слоя: рамка, фильтр base64url, время', () => {
    const filter = { field: 'district', op: 'eq' as const, value: 'Хатлон' }
    const query = featuresQuery(
      { bbox: [68.5, 38.4, 69, 38.7], filter, time: { from: '2026-03-01', to: '2026-03-31' } },
      5000,
    )
    expect(query).toEqual({
      limit: '5000',
      bbox: '68.500000,38.400000,69.000000,38.700000',
      f: encodeFilter(filter),
      t: '2026-03-01/2026-03-31',
    })
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(query.f?.replaceAll('-', '+').replaceAll('_', '/') ?? ''), (c) =>
          c.charCodeAt(0),
        ),
      ),
    )
    expect(decoded).toEqual(filter)
  })
})

describe('подпись объекта', () => {
  it('заголовок карточки, поле подписи, первое текстовое поле', () => {
    const titled = {
      style: style({ popup: { title: '{{name}} ({{kind}})', fields: [], actions: [] } }),
    }
    expect(featureLabel(titled, { name: 'Школа № 1', kind: 'школа' })).toBe('Школа № 1 (школа)')
    // Поля шаблона нет в тайле — следующий способ
    expect(featureLabel(titled, { name: 'Школа № 1', code: 'A-1' })).toBe('Школа № 1')
    const labelled = { style: style({ label: { field: 'code' } }) }
    expect(featureLabel(labelled, { code: 'A-1', name: 'Школа' })).toBe('A-1')
    expect(featureLabel({ style: style() }, { point_count: 1, amount: 5 })).toBeNull()
  })
})

describe('выделение датасета между панелями', () => {
  it('строки датасета из выделения слоёв — без повторов', () => {
    const selection = [
      { layerId: 'A', rowId: '1' },
      { layerId: 'B', rowId: '1' },
      { layerId: 'B', rowId: '2' },
      { layerId: 'C', rowId: '9' },
    ]
    expect(datasetRowIds(selection, ['A', 'B'])).toEqual(['1', '2'])
  })

  it('чужое выделение датасета — на всех его слоях, остальные слои не трогаются', () => {
    const selection = [
      { layerId: 'A', rowId: '1' },
      { layerId: 'C', rowId: '9' },
    ]
    expect(withDatasetSelection(selection, ['A', 'B'], ['5'])).toEqual([
      { layerId: 'C', rowId: '9' },
      { layerId: 'A', rowId: '5' },
      { layerId: 'B', rowId: '5' },
    ])
    expect(withDatasetSelection(selection, ['A'], [])).toEqual([{ layerId: 'C', rowId: '9' }])
  })
})
