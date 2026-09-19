import { describe, expect, it } from 'vitest'
import { MapSpec } from '../../gis/map.js'
import {
  type DashboardFilter,
  DashboardSpec,
  dashboardFiltersWhere,
  dashboardMapFilters,
} from '../dashboard.js'
import { NotebookCell } from '../notebook.js'

const INCIDENTS = '01890000-0000-7000-8000-000000000001'
const OBJECTS = '01890000-0000-7000-8000-000000000002'
const MAP = '01890000-0000-7000-8000-000000000003'

const filter = (id: string, kind: DashboardFilter['kind'], extra: Partial<DashboardFilter> = {}) =>
  ({ id, kind, label: { ru: id }, ...extra }) as DashboardFilter

describe('плитка-карта дашборда (ADR-0074)', () => {
  it('вид и привязки по умолчанию; карта — зависимость плитки', () => {
    const spec = DashboardSpec.parse({
      tiles: [{ id: 'm', kind: 'map', mapId: MAP, map: {}, x: 0, y: 0, w: 6, h: 5 }],
    })
    expect(spec.tiles[0]).toMatchObject({
      kind: 'map',
      mapId: MAP,
      map: { camera: null, bindings: {} },
      filterBindings: {},
    })
    // Привязка — к полю датасета слоя: ключ — идентификатор датасета
    expect(() =>
      DashboardSpec.parse({
        tiles: [
          {
            id: 'm',
            kind: 'map',
            mapId: MAP,
            map: { bindings: { district: { 'not-a-dataset': 'district' } } },
            x: 0,
            y: 0,
            w: 6,
            h: 5,
          },
        ],
      }),
    ).toThrow()
  })

  it('условия по датасетам: фильтры, привязанные к полям каждого датасета', () => {
    const filters = [
      filter('district', 'territory'),
      filter('period', 'period', { default: { unit: 'month', from: 0, to: 0 } }),
      filter('kind', 'select'),
    ]
    const bindings = {
      district: { [INCIDENTS]: 'territory', [OBJECTS]: 'district' },
      period: { [INCIDENTS]: 'occurred_at' },
      kind: { [OBJECTS]: 'kind' },
    }
    const byDataset = dashboardMapFilters(
      filters,
      { bindings },
      {
        district: { id: 'T-1', includeChildren: true },
        kind: ['school'],
      },
    )
    expect(byDataset).toEqual({
      [INCIDENTS]: {
        and: [
          { field: 'territory', op: 'within', value: { id: 'T-1', includeChildren: true } },
          { field: 'occurred_at', op: 'relative', value: { unit: 'month', from: 0, to: 0 } },
        ],
      },
      [OBJECTS]: {
        and: [
          { field: 'district', op: 'within', value: { id: 'T-1', includeChildren: true } },
          { field: 'kind', op: 'in', value: ['school'] },
        ],
      },
    })
    // Пустые значения условий не дают; датасет без условий — без `f`
    expect(dashboardMapFilters(filters, { bindings }, { period: null, district: null })).toEqual({})
    // Значение не выбрано — действует значение фильтра по умолчанию
    expect(dashboardMapFilters(filters, { bindings }, {})).toEqual({
      [INCIDENTS]: {
        field: 'occurred_at',
        op: 'relative',
        value: { unit: 'month', from: 0, to: 0 },
      },
    })
  })

  it('без привязок и значений — пусто; одно условие — без `and`', () => {
    expect(dashboardMapFilters([filter('kind', 'select')], undefined, { kind: 'x' })).toEqual({})
    expect(
      dashboardFiltersWhere([filter('kind', 'select')], { kind: 'kind' }, { kind: 'school' }),
    ).toEqual({ field: 'kind', op: 'eq', value: 'school' })
    expect(dashboardFiltersWhere([filter('kind', 'select')], {}, { kind: 'school' })).toBeNull()
  })
})

describe('время карты и ячейка карты тетради', () => {
  it('MapSpec.time: интервал с режимом и шагом, прежний вид без них', () => {
    const plain = MapSpec.parse({ time: { from: '2026-03-01', to: '2026-03-31' } })
    expect(plain.time).toEqual({ from: '2026-03-01', to: '2026-03-31' })
    const full = MapSpec.parse({
      time: { from: '2026-03-01', to: '2026-03-01', mode: 'instant', step: 'day' },
    })
    expect(full.time).toMatchObject({ mode: 'instant', step: 'day' })
    expect(() => MapSpec.parse({ time: { from: 'a', to: 'b', step: 'decade' } })).toThrow()
  })

  it('ячейка карты: карта или слой, вид по умолчанию — null', () => {
    const cell = NotebookCell.parse({ id: 'm', kind: 'map', layerId: MAP })
    expect(cell).toEqual({
      id: 'm',
      kind: 'map',
      title: null,
      mapId: null,
      layerId: MAP,
      camera: null,
    })
  })
})
