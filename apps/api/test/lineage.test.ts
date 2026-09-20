import { beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Происхождение и влияние (P5-E03, ADR-0102): граф зависимостей вокруг
 * объекта строится в обе стороны и показывает только то, что доступно
 * смотрящему — чужой дашборд не выдаёт себя даже ребром.
 */
registerLifecycle()

const run = Date.now().toString(36)
let fx: TestContext
let datasetId = ''
let dashboardId = ''

/** Запрос «людей по районам» и столбиковая диаграмма по нему. */
const byDistrict = (id: string) => ({
  version: 1,
  source: { kind: 'dataset', id },
  steps: [
    {
      type: 'aggregate',
      groupBy: [{ field: 'district' }],
      measures: [{ alias: 'n', agg: 'count' }],
    },
  ],
})

const barSpec = (id: string) => ({
  version: 1,
  type: 'bar',
  data: { query: byDistrict(id) },
  encoding: {
    x: { field: 'district', type: 'nominal' },
    y: [{ field: 'n', type: 'quantitative' }],
  },
})

const lineage = (id: string, as = fx.admin, depth = 3) =>
  call(fx.app, { url: `/objects/${id}/lineage?depth=${depth}`, as })

beforeAll(async () => {
  fx = await setupFixture()
  const dataset = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Происхождение ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
        { key: 'people', label: { ru: 'Людей' }, type: 'integer', semantic: 'measure' },
      ],
    },
  })
  expect(dataset.statusCode, dataset.body).toBe(200)
  datasetId = dataset.json().id as string

  // Дашборд с плиткой по этому датасету: зависимость считает модуль данных
  const dashboard = await call(fx.app, {
    method: 'POST',
    url: '/dashboards',
    as: fx.admin,
    payload: {
      name: `Сводка ${run}`,
      spaceId: fx.spaceId,
      spec: {
        tiles: [{ id: 'inline', kind: 'chart', spec: barSpec(datasetId), x: 0, y: 0, w: 6, h: 4 }],
      },
    },
  })
  expect(dashboard.statusCode, dashboard.body).toBe(200)
  dashboardId = dashboard.json().id as string
})

describe('граф происхождения', () => {
  it('от датасета виден потребитель, от дашборда — источник', async () => {
    const fromDataset = await lineage(datasetId)
    expect(fromDataset.statusCode, fromDataset.body).toBe(200)
    const down = fromDataset.json()
    expect(down.nodes.map((node: { objectId: string }) => node.objectId)).toContain(dashboardId)
    expect(
      down.edges.some(
        (edge: { from: string; to: string }) => edge.from === dashboardId && edge.to === datasetId,
      ),
    ).toBe(true)
    const consumer = down.nodes.find((node: { objectId: string }) => node.objectId === dashboardId)
    expect(consumer.depth, 'потребитель — вниз по графу').toBeGreaterThan(0)

    const fromDashboard = await lineage(dashboardId)
    const up = fromDashboard.json()
    const source = up.nodes.find((node: { objectId: string }) => node.objectId === datasetId)
    expect(source, 'источник виден').toBeTruthy()
    expect(source.depth, 'источник — вверх по графу').toBeLessThan(0)
  })

  it('недоступные узлы и их рёбра в граф не попадают', async () => {
    const closed = await call(fx.app, {
      method: 'POST',
      url: '/spaces',
      as: fx.admin,
      payload: { key: `lineage-${run}`, name: `Закрытое ${run}`, kind: 'team' },
    })
    expect(closed.statusCode, closed.body).toBe(200)

    const secret = await call(fx.app, {
      method: 'POST',
      url: '/dashboards',
      as: fx.admin,
      payload: {
        name: `Секретная сводка ${run}`,
        spaceId: closed.json().id as string,
        spec: {
          tiles: [
            { id: 'inline', kind: 'chart', spec: barSpec(datasetId), x: 0, y: 0, w: 6, h: 4 },
          ],
        },
      },
    })
    expect(secret.statusCode, secret.body).toBe(200)
    const secretId = secret.json().id as string

    const asAdmin = await lineage(datasetId)
    expect(asAdmin.json().nodes.map((node: { objectId: string }) => node.objectId)).toContain(
      secretId,
    )

    const asMember = await lineage(datasetId, fx.users.member)
    expect(asMember.statusCode, asMember.body).toBe(200)
    const ids = asMember.json().nodes.map((node: { objectId: string }) => node.objectId)
    expect(ids, 'закрытый дашборд не виден').not.toContain(secretId)
    expect(
      asMember.json().edges.some((edge: { from: string }) => edge.from === secretId),
      'и его ребро тоже',
    ).toBe(false)
  })

  it('посторонний графа не получает', async () => {
    const response = await lineage(datasetId, fx.users.stranger)
    expect(response.statusCode).toBe(404)
  })
})
