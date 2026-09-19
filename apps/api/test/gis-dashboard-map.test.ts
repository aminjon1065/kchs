import { gunzipSync } from 'node:zlib'
import {
  type DashboardFilter,
  type DashboardRecord,
  dashboardMapFilters,
  type FilterNode,
} from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'
import { decodeMvt, type MvtFeature } from './mvt.js'

/**
 * Карта на дашборде и в тетради, время карты (P2-E02 S04–S05, ADR-0074):
 * плитка-карта — ссылка на карту с видом и привязкой фильтров дашборда к
 * полям датасетов слоёв; условия фильтров (общая функция контракта) уходят
 * тайлам параметром `f`, интервал карты — параметром `t`; политики строк
 * смотрящего действуют поверх. Ячейка тетради — карта или слой с видом.
 */
registerLifecycle()

const { dependencies } = await import('../src/shared/db/schema/index.js')

let fx: TestContext
let datasetId: string
let layerId: string
let mapId: string
let dashboardId: string
const run = Date.now().toString(36)

const point = (lon: number, lat: number) => ({ type: 'Point', coordinates: [lon, lat] })

/** Весь Таджикистан на z6 — один тайл. */
const TJ = { z: 6, x: 44, y: 24 }

const encode = (filter: FilterNode) => Buffer.from(JSON.stringify(filter)).toString('base64url')

async function tileNames(query: string, as = fx.admin): Promise<string[]> {
  const response = await call(fx.app, {
    url: `/gis/layers/${layerId}/tiles/${TJ.z}/${TJ.x}/${TJ.y}.pbf?${query}`,
    as,
    headers: { 'accept-encoding': 'gzip' },
  })
  if (response.statusCode === 204) return []
  expect(response.statusCode, response.body).toBe(200)
  const raw = (response as unknown as { rawPayload: Buffer }).rawPayload
  const layers = decodeMvt(response.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw)
  return ((layers[0]?.features ?? []) as MvtFeature[])
    .map((feature) => feature.properties.name as string)
    .sort()
}

async function usesOf(id: string): Promise<string[]> {
  const rows = await db()
    .select({ toId: dependencies.toId })
    .from(dependencies)
    .where(eq(dependencies.fromId, id))
  return rows.map((row) => row.toId)
}

beforeAll(async () => {
  fx = await setupFixture()
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Происшествия ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'name', label: { ru: 'Название' }, type: 'text' },
        { key: 'district', label: { ru: 'Регион' }, type: 'text', semantic: 'category' },
        { key: 'kind', label: { ru: 'Вид' }, type: 'text', semantic: 'category' },
        { key: 'day', label: { ru: 'Дата' }, type: 'date', semantic: 'time' },
        { key: 'place', label: { ru: 'Место' }, type: 'geometry' },
      ],
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  datasetId = created.json().id
  const rows = [
    ['Сель Вахш', 'Хатлон', 'mudflow', '2026-03-01', point(68.78, 37.83)],
    ['Пожар Куляб', 'Хатлон', 'fire', '2026-03-15', point(69.78, 37.91)],
    ['Пожар Худжанд', 'Согд', 'fire', '2026-04-02', point(69.62, 40.28)],
    ['Лавина Хорог', 'ГБАО', 'avalanche', '2026-05-10', point(71.55, 37.49)],
  ] as const
  const inserted = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows`,
    as: fx.admin,
    payload: {
      rows: rows.map(([name, district, kind, day, place]) => ({
        values: { name, district, kind, day, place },
      })),
    },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)

  const layer = await call(fx.app, {
    method: 'POST',
    url: '/gis/layers',
    as: fx.admin,
    payload: {
      name: `Происшествия ${run}`,
      spaceId: fx.spaceId,
      datasetId,
      style: {
        version: 1,
        geometry: 'point',
        renderer: { kind: 'simple', color: 'danger' },
        cluster: null,
        label: { field: 'name' },
        time: { field: 'day', mode: 'instant', step: 'month' },
      },
    },
  })
  expect(layer.statusCode, layer.body).toBe(200)
  layerId = layer.json().id

  const map = await call(fx.app, {
    method: 'POST',
    url: '/gis/maps',
    as: fx.admin,
    payload: {
      name: `Обстановка ${run}`,
      spaceId: fx.spaceId,
      spec: {
        layers: [{ layerId }],
        // Время карты: март, шкала «момент» по месяцам
        time: { from: '2026-03-01', to: '2026-03-31', mode: 'instant', step: 'month' },
      },
    },
  })
  expect(map.statusCode, map.body).toBe(200)
  mapId = map.json().id
})

describe('время карты', () => {
  it('интервал с режимом и шагом хранится в карте и ограничивает тайлы слоя со временем', async () => {
    const record = await call(fx.app, { url: `/gis/maps/${mapId}`, as: fx.users.viewer })
    expect(record.statusCode, record.body).toBe(200)
    expect(record.json().spec.time).toEqual({
      from: '2026-03-01',
      to: '2026-03-31',
      mode: 'instant',
      step: 'month',
    })
    // Кадры шкалы — дискретные интервалы шага: март, апрель; без `t` — все объекты
    expect(await tileNames('t=2026-03-01/2026-03-31')).toEqual(['Пожар Куляб', 'Сель Вахш'])
    expect(await tileNames('t=2026-04-01/2026-04-30')).toEqual(['Пожар Худжанд'])
    expect(await tileNames('')).toHaveLength(4)
    // Накопление: от начала данных до конца кадра
    expect(await tileNames('t=2026-03-01/2026-04-30')).toHaveLength(3)
  })
})

describe('плитка-карта дашборда', () => {
  const filters: DashboardFilter[] = [
    { id: 'district', kind: 'select', label: { ru: 'Регион' } },
    { id: 'period', kind: 'period', label: { ru: 'Период' } },
  ]

  it('карта с видом и привязками — зависимость дашборда; данные плиток её не считают', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/dashboards',
      as: fx.admin,
      payload: {
        name: `Карта на дашборде ${run}`,
        spaceId: fx.spaceId,
        spec: {
          filters,
          tiles: [
            {
              id: 'map',
              kind: 'map',
              mapId,
              title: 'Обстановка',
              map: {
                camera: { center: [69.5, 38.5], zoom: 6 },
                bindings: {
                  district: { [datasetId]: 'district' },
                  period: { [datasetId]: 'day' },
                },
              },
              x: 0,
              y: 0,
              w: 6,
              h: 5,
            },
            { id: 'note', kind: 'text', text: 'Сводка', x: 6, y: 0, w: 6, h: 2 },
          ],
        },
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    dashboardId = created.json().id

    const record = await call(fx.app, { url: `/dashboards/${dashboardId}`, as: fx.users.viewer })
    expect(record.statusCode, record.body).toBe(200)
    const tile = (record.json() as DashboardRecord).spec.tiles.find((item) => item.id === 'map')
    expect(tile).toMatchObject({
      kind: 'map',
      mapId,
      map: {
        camera: { center: [69.5, 38.5], zoom: 6, bearing: 0, pitch: 0 },
        bindings: { district: { [datasetId]: 'district' }, period: { [datasetId]: 'day' } },
      },
    })
    expect(await usesOf(dashboardId)).toEqual([mapId])

    // Плитка-карта читает тайлы сама: в данных плиток её нет, запрос не падает
    const data = await call(fx.app, {
      method: 'POST',
      url: `/dashboards/${dashboardId}/data`,
      as: fx.users.viewer,
      payload: { filters: { district: 'Хатлон' } },
    })
    expect(data.statusCode, data.body).toBe(200)
    expect(Object.keys(data.json().tiles)).toEqual([])
  })

  it('фильтры дашборда → условие `f` тайлов слоя этого датасета, политики строк — поверх', async () => {
    const record = (await call(fx.app, { url: `/dashboards/${dashboardId}`, as: fx.admin })).json()
    const spec = (record as DashboardRecord).spec
    const tile = spec.tiles.find((item) => item.id === 'map')
    const conditions = (values: Record<string, unknown>) =>
      dashboardMapFilters(spec.filters, tile?.map, values)

    const hatlon = conditions({ district: 'Хатлон' })
    expect(Object.keys(hatlon)).toEqual([datasetId])
    expect(await tileNames(`f=${encode(hatlon[datasetId] as FilterNode)}`)).toEqual([
      'Пожар Куляб',
      'Сель Вахш',
    ])

    // Регион и период вместе; фильтр карты сочетается с её временем
    const both = conditions({
      district: ['Хатлон', 'Согд'],
      period: ['2026-03-10', '2026-04-30'],
    })
    const f = encode(both[datasetId] as FilterNode)
    expect(await tileNames(`f=${f}`)).toEqual(['Пожар Куляб', 'Пожар Худжанд'])
    expect(await tileNames(`f=${f}&t=2026-04-01/2026-04-30`)).toEqual(['Пожар Худжанд'])

    // Без значений фильтров — без условия: плитка показывает всё, что видит смотрящий
    expect(conditions({})).toEqual({})

    // Политика строк читателя сужает и отфильтрованные тайлы
    const policy = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/policies/rows`,
      as: fx.admin,
      payload: {
        principal: { type: 'user', id: fx.users.viewer.id },
        filter: { field: 'kind', op: 'eq', value: 'fire' },
      },
    })
    expect(policy.statusCode, policy.body).toBe(200)
    expect(
      await tileNames(`f=${encode(hatlon[datasetId] as FilterNode)}`, fx.users.viewer),
    ).toEqual(['Пожар Куляб'])
  })

  it('на недоступную автору карту плитку не добавить', async () => {
    const response = await call(fx.app, {
      method: 'PATCH',
      url: `/dashboards/${dashboardId}`,
      as: fx.admin,
      payload: {
        spec: {
          tiles: [
            {
              id: 'ghost',
              kind: 'map',
              mapId: '01a0b5f6-7abe-7b86-900a-a7d6ac3fc64e',
              x: 0,
              y: 0,
              w: 6,
              h: 5,
            },
          ],
        },
      },
    })
    expect(response.statusCode).toBe(404)
    // Чужой (не участник пространства) карту не видит — плитка у него «нет доступа»
    const hidden = await call(fx.app, { url: `/gis/maps/${mapId}`, as: fx.users.stranger })
    expect(hidden.statusCode).toBe(404)
  })
})

describe('ячейка карты тетради', () => {
  it('слой по ссылке с видом: снимок, зависимость; невидимый автору слой — отказ', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/notebooks',
      as: fx.admin,
      payload: {
        name: `Тетрадь с картой ${run}`,
        spaceId: fx.spaceId,
        cells: [
          { id: 'layer', kind: 'map', layerId, camera: { center: [69, 38], zoom: 7 } },
          { id: 'map', kind: 'map', mapId },
        ],
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const notebookId = created.json().id as string
    const record = await call(fx.app, { url: `/notebooks/${notebookId}`, as: fx.admin })
    expect(record.statusCode, record.body).toBe(200)
    expect(record.json().cells).toEqual([
      {
        id: 'layer',
        kind: 'map',
        title: null,
        mapId: null,
        layerId,
        camera: { center: [69, 38], zoom: 7, bearing: 0, pitch: 0 },
      },
      { id: 'map', kind: 'map', title: null, mapId, layerId: null, camera: null },
    ])
    expect((await usesOf(notebookId)).sort()).toEqual([layerId, mapId].sort())

    const foreign = await call(fx.app, {
      method: 'POST',
      url: '/notebooks',
      as: fx.users.stranger,
      payload: {
        name: 'Чужая',
        spaceId: fx.orgSpaceId,
        cells: [{ id: 'm', kind: 'map', layerId }],
      },
    })
    expect([403, 404]).toContain(foreign.statusCode)
  })
})
