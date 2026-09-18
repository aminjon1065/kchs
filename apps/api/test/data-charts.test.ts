import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, redis, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Графики и дашборды (P1-E06 S01, S03): данные — с политиками смотрящего,
 * фильтры дашборда — по привязкам плиток, плитка без доступа — «нет доступа».
 */
registerLifecycle()

const { SpaceService } = await import('../src/kernel/spaces/service.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext
let datasetId: string
let chartId: string
const run = Date.now().toString(36)

const byDistrict = (id: string) => ({
  version: 1,
  source: { kind: 'dataset', id },
  steps: [
    {
      type: 'aggregate',
      groupBy: [{ field: 'district' }],
      measures: [{ alias: 'n', agg: 'count' }],
    },
    { type: 'sort', by: [{ field: 'district', dir: 'asc' }] },
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

function records(body: { fields: Array<{ name: string }>; rows: unknown[][] }) {
  return body.rows.map((row) => Object.fromEntries(body.fields.map((f, i) => [f.name, row[i]])))
}

beforeAll(async () => {
  fx = await setupFixture()
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Графики ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier' },
        { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
      ],
      primaryKey: ['code'],
    },
  })
  datasetId = created.json().id
  const rows = ['Хатлон', 'Хатлон', 'Согд', 'ГБАО'].map((district, index) => ({
    values: { code: `C-${index}`, district },
  }))
  const inserted = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows`,
    as: fx.admin,
    payload: { rows },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)
})

describe('график', () => {
  it('создание, данные по спецификации, зависимость от датасета', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/charts',
      as: fx.admin,
      payload: { name: `По районам ${run}`, spaceId: fx.spaceId, spec: barSpec(datasetId) },
    })
    expect(created.statusCode, created.body).toBe(200)
    chartId = created.json().id

    const record = await call(fx.app, { url: `/charts/${chartId}`, as: fx.admin })
    expect(record.json()).toMatchObject({ name: `По районам ${run}`, spec: { type: 'bar' } })

    const data = await call(fx.app, {
      method: 'POST',
      url: `/charts/${chartId}/data`,
      as: fx.admin,
      payload: {},
    })
    expect(data.statusCode, data.body).toBe(200)
    expect(records(data.json())).toEqual([
      { district: 'ГБАО', n: 1 },
      { district: 'Согд', n: 1 },
      { district: 'Хатлон', n: 2 },
    ])

    const links = await call(fx.app, { url: `/objects/${chartId}/links`, as: fx.admin })
    expect(links.json().uses.map((item: { id: string }) => item.id)).toContain(datasetId)
  })

  it('данные графика — с политикой строк смотрящего; правка — событие chart.updated', async () => {
    await db().execute(
      sql`INSERT INTO dataset_row_policies (id, dataset_id, principal_type, principal_id, filter)
          VALUES (gen_random_uuid(), ${datasetId}, 'user', ${fx.users.viewer.id},
                  ${JSON.stringify({ field: 'district', op: 'eq', value: 'Хатлон' })}::jsonb)`,
    )
    const viewer = await call(fx.app, {
      method: 'POST',
      url: `/charts/${chartId}/data`,
      as: fx.users.viewer,
      payload: {},
    })
    expect(viewer.statusCode, viewer.body).toBe(200)
    expect(records(viewer.json())).toEqual([{ district: 'Хатлон', n: 2 }])

    const renamed = await call(fx.app, {
      method: 'PATCH',
      url: `/charts/${chartId}`,
      as: fx.admin,
      payload: { spec: { ...barSpec(datasetId), type: 'pie' } },
    })
    expect(renamed.statusCode, renamed.body).toBe(200)
    expect(renamed.json().spec.type).toBe('pie')
    const events = await db().execute<{ payload: { changed: string[] } }>(
      sql`SELECT event->'payload' AS payload FROM ops.outbox
           WHERE type = 'chart.updated' AND event->'object'->>'id' = ${chartId}`,
    )
    expect(events.map((row) => row.payload)).toEqual([{ changed: ['spec'] }])

    const forbidden = await call(fx.app, {
      method: 'PATCH',
      url: `/charts/${chartId}`,
      as: fx.users.viewer,
      payload: { name: 'Чужая правка' },
    })
    expect(forbidden.statusCode).toBe(403)
    const stranger = await call(fx.app, {
      method: 'POST',
      url: `/charts/${chartId}/data`,
      as: fx.users.stranger,
      payload: {},
    })
    expect(stranger.statusCode).toBe(404)
  })
})

describe('дашборд', () => {
  it('плитки одним запросом: фильтр по привязке, встроенная плитка, плитка без доступа', async () => {
    // График в пространстве, где читателя нет, — для плитки «нет доступа»
    const privateSpace = await db().transaction((tx) =>
      SpaceService.create(tx, systemCtx('test'), {
        key: `private-${run}`,
        name: 'Закрытое',
        kind: 'team',
        ownerId: fx.admin.id,
      }),
    )
    await redis().del(`kchs:principals:${fx.admin.id}`)
    const hidden = await call(fx.app, {
      method: 'POST',
      url: '/charts',
      as: fx.admin,
      payload: { name: `Закрытый ${run}`, spaceId: privateSpace, spec: barSpec(datasetId) },
    })
    expect(hidden.statusCode, hidden.body).toBe(200)

    const created = await call(fx.app, {
      method: 'POST',
      url: '/dashboards',
      as: fx.admin,
      payload: {
        name: `Обстановка ${run}`,
        spaceId: fx.spaceId,
        spec: {
          filters: [{ id: 'district', kind: 'select', label: { ru: 'Район' } }],
          tiles: [
            {
              id: 'saved',
              kind: 'chart',
              chartId,
              filterBindings: { district: 'district' },
              x: 0,
              y: 0,
              w: 6,
              h: 4,
            },
            { id: 'inline', kind: 'chart', spec: barSpec(datasetId), x: 6, y: 0, w: 6, h: 4 },
            { id: 'hidden', kind: 'chart', chartId: hidden.json().id, x: 0, y: 4, w: 6, h: 4 },
            { id: 'note', kind: 'text', text: '## Сводка', x: 6, y: 4, w: 6, h: 2 },
          ],
        },
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const dashboardId = created.json().id as string

    const admin = await call(fx.app, {
      method: 'POST',
      url: `/dashboards/${dashboardId}/data`,
      as: fx.admin,
      payload: { filters: { district: 'Согд' } },
    })
    expect(admin.statusCode, admin.body).toBe(200)
    const tiles = admin.json().tiles
    expect(Object.keys(tiles).sort()).toEqual(['hidden', 'inline', 'saved'])
    // Фильтр привязан только к плитке «saved»
    expect(records(tiles.saved.result)).toEqual([{ district: 'Согд', n: 1 }])
    expect(records(tiles.inline.result)).toHaveLength(3)
    expect(tiles.hidden.error).toBeNull()

    const viewer = await call(fx.app, {
      method: 'POST',
      url: `/dashboards/${dashboardId}/data`,
      as: fx.users.viewer,
      payload: {},
    })
    expect(viewer.statusCode, viewer.body).toBe(200)
    expect(viewer.json().tiles.hidden).toMatchObject({
      error: 'no_access',
      spec: null,
      result: null,
    })
    // Политика строк читателя действует и на плитках
    expect(records(viewer.json().tiles.inline.result)).toEqual([{ district: 'Хатлон', n: 2 }])

    const record = await call(fx.app, { url: `/dashboards/${dashboardId}`, as: fx.users.viewer })
    expect(record.json().spec.tiles).toHaveLength(4)
    const edit = await call(fx.app, {
      method: 'PATCH',
      url: `/dashboards/${dashboardId}`,
      as: fx.users.viewer,
      payload: { name: 'Правка читателя' },
    })
    expect(edit.statusCode).toBe(403)
  })

  it('плитку на недоступный автору график добавить нельзя', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/dashboards',
      as: fx.users.member,
      payload: {
        name: `Чужое ${run}`,
        spaceId: fx.spaceId,
        spec: {
          tiles: [
            {
              id: 't',
              kind: 'chart',
              chartId: '01a0b5f6-7abe-7b86-900a-a7d6ac3fc64e',
              x: 0,
              y: 0,
              w: 4,
              h: 3,
            },
          ],
        },
      },
    })
    expect(response.statusCode).toBe(404)
  })
})
