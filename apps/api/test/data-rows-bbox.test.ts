import { beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Строки таблицы в охвате карты (ADR-0073): атрибутивная таблица слоя и таблица
 * датасета, связанная с картой, сужаются рамкой — пространственным окном
 * компилятора рядом с политикой строк (ADR-0064), со счётчиком и страницами.
 */
registerLifecycle()

let fx: TestContext
let datasetId: string
const run = Date.now().toString(36)

const point = (lon: number, lat: number) => ({ type: 'Point', coordinates: [lon, lat] })

/** Душанбе и окрестности — рамка, в которую попадают первые три строки. */
const DUSHANBE = [68.6, 38.4, 69.0, 38.7] as const

const rows = (payload: Record<string, unknown>, as = fx.admin) =>
  call(fx.app, { method: 'POST', url: `/datasets/${datasetId}/rows/query`, as, payload })

const names = (body: { fields: Array<{ name: string }>; rows: unknown[][] }) => {
  const index = body.fields.findIndex((field) => field.name === 'name')
  return body.rows.map((row) => row[index] as string).sort()
}

beforeAll(async () => {
  fx = await setupFixture()
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Пункты ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'name', label: { ru: 'Название' }, type: 'text' },
        { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
        { key: 'place', label: { ru: 'Место' }, type: 'geometry' },
      ],
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  datasetId = created.json().id
  const inserted = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows`,
    as: fx.admin,
    payload: {
      rows: [
        ['Вокзал', 'Душанбе', point(68.78, 38.56)],
        ['Цирк', 'Душанбе', point(68.8, 38.58)],
        ['Гиссар', 'РРП', point(68.66, 38.52)],
        ['Бохтар', 'Хатлон', point(68.78, 37.83)],
        ['Худжанд', 'Согд', point(69.62, 40.28)],
        ['Без места', 'Душанбе', null],
      ].map(([name, district, place]) => ({ values: { name, district, place } })),
    },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)
})

describe('строки в охвате карты', () => {
  it('рамка сужает страницу и счётчик; поиск и фильтр действуют вместе с ней', async () => {
    const all = await rows({ limit: 50 })
    expect(all.json().rowCount).toBe(6)

    const inBox = await rows({ bbox: { field: 'place', bbox: DUSHANBE }, limit: 50 })
    expect(inBox.statusCode, inBox.body).toBe(200)
    expect(inBox.json().rowCount).toBe(3)
    expect(names(inBox.json())).toEqual(['Вокзал', 'Гиссар', 'Цирк'])

    const page = await rows({
      bbox: { field: 'place', bbox: DUSHANBE },
      sort: [{ field: 'name', dir: 'asc' }],
      limit: 2,
      offset: 1,
    })
    expect(page.json().rowCount).toBe(3)
    expect(names(page.json())).toEqual(['Гиссар', 'Цирк'])

    const searched = await rows({ bbox: { field: 'place', bbox: DUSHANBE }, search: 'цир' })
    expect(names(searched.json())).toEqual(['Цирк'])

    const filtered = await rows({
      bbox: { field: 'place', bbox: DUSHANBE },
      where: { field: 'district', op: 'eq', value: 'Душанбе' },
    })
    expect(names(filtered.json())).toEqual(['Вокзал', 'Цирк'])
  })

  it('политика строк смотрящего действует и в охвате', async () => {
    const policy = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/policies/rows`,
      as: fx.admin,
      payload: {
        principal: { type: 'user', id: fx.users.viewer.id },
        filter: { field: 'district', op: 'eq', value: 'РРП' },
      },
    })
    expect(policy.statusCode, policy.body).toBe(200)
    const viewer = await rows({ bbox: { field: 'place', bbox: DUSHANBE } }, fx.users.viewer)
    expect(viewer.statusCode, viewer.body).toBe(200)
    expect(viewer.json().rowCount).toBe(1)
    expect(names(viewer.json())).toEqual(['Гиссар'])
  })

  it('поле не геометрия или скрыто политикой столбцов — 400', async () => {
    const wrong = await rows({ bbox: { field: 'name', bbox: DUSHANBE } })
    expect(wrong.statusCode, wrong.body).toBe(400)

    const hidden = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/policies/columns`,
      as: fx.admin,
      payload: {
        principal: { type: 'user', id: fx.users.viewer.id },
        fields: ['place'],
        mode: 'hide',
      },
    })
    expect(hidden.statusCode, hidden.body).toBe(200)
    const denied = await rows({ bbox: { field: 'place', bbox: DUSHANBE } }, fx.users.viewer)
    expect(denied.statusCode, denied.body).toBe(400)

    const inverted = await rows({ bbox: { field: 'place', bbox: [69, 38.7, 68.6, 38.4] } })
    expect(inverted.statusCode, inverted.body).toBe(400)
  })
})
