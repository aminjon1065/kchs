import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Строки датасета и выполнение запросов (P1-E01 S03, P1-E04, ADR-0051):
 * чтение через компилятор с политиками, правка с `_ver`, история, кэш.
 */
registerLifecycle()

let fx: TestContext
let datasetId: string
const run = Date.now().toString(36)

const ROWS = [
  { code: 'INC-0001', district: 'Хатлон', amount: 120.5, day: '2026-03-01', tags: ['паводок'] },
  { code: 'INC-0002', district: 'Согд', amount: 40, day: '2026-03-02', tags: ['сель', 'паводок'] },
  { code: 'INC-0003', district: 'Хатлон', amount: 75, day: '2026-03-03', tags: [] },
  {
    code: 'INC-0004',
    district: 'ГБАО',
    amount: null,
    day: '2026-03-04',
    point: { type: 'Point', coordinates: [71.55, 37.49] },
  },
]

beforeAll(async () => {
  fx = await setupFixture()
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Строки ${run}`,
      spaceId: fx.spaceId,
      fields: [
        {
          key: 'code',
          label: { ru: 'Код' },
          type: 'identifier',
          semantic: 'identifier',
          required: true,
        },
        { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
        { key: 'amount', label: { ru: 'Ущерб' }, type: 'number', semantic: 'measure' },
        { key: 'day', label: { ru: 'Дата' }, type: 'date', semantic: 'time' },
        { key: 'tags', label: { ru: 'Метки' }, type: 'multi_select' },
        { key: 'point', label: { ru: 'Место' }, type: 'geometry', semantic: 'geometry' },
      ],
      primaryKey: ['code'],
      timeField: 'day',
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  datasetId = created.json().id
})

const rowsQuery = (payload: Record<string, unknown>, as = fx.admin) =>
  call(fx.app, { method: 'POST', url: `/datasets/${datasetId}/rows/query`, as, payload })

/** Строки ответа как объекты по именам полей. */
function records(body: { fields: Array<{ name: string }>; rows: unknown[][] }) {
  return body.rows.map((row) => Object.fromEntries(body.fields.map((f, i) => [f.name, row[i]])))
}

async function addPolicy(values: {
  table: 'dataset_row_policies' | 'dataset_column_policies'
  userId: string
  filter?: unknown
  mode?: string
  fields?: string[]
}) {
  if (values.table === 'dataset_row_policies') {
    await db().execute(
      sql`INSERT INTO dataset_row_policies (id, dataset_id, principal_type, principal_id, filter)
          VALUES (gen_random_uuid(), ${datasetId}, 'user', ${values.userId}, ${JSON.stringify(values.filter)}::jsonb)`,
    )
  } else {
    await db().execute(
      sql`INSERT INTO dataset_column_policies (id, dataset_id, principal_type, principal_id, mode, fields)
          VALUES (gen_random_uuid(), ${datasetId}, 'user', ${values.userId}, ${values.mode},
                  ${`{${(values.fields ?? []).join(',')}}`}::text[])`,
    )
  }
}

describe('строки: вставка и чтение', () => {
  it('вставка — строки с _id и _ver, версия правки, событие, история', async () => {
    const inserted = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/rows`,
      as: fx.admin,
      payload: { rows: ROWS.map((values) => ({ values })) },
    })
    expect(inserted.statusCode, inserted.body).toBe(200)
    const items = inserted.json().items
    expect(items).toHaveLength(4)
    expect(items[0]).toMatchObject({ _ver: 1, values: { code: 'INC-0001', amount: 120.5 } })
    expect(items[0]._id).toMatch(/^\d+$/)

    const dataset = await call(fx.app, { url: `/datasets/${datasetId}`, as: fx.admin })
    expect(dataset.json()).toMatchObject({ rowCount: 4, currentVersion: 2 })
    const versions = await call(fx.app, { url: `/datasets/${datasetId}/versions`, as: fx.admin })
    expect(versions.json().items[0]).toMatchObject({
      origin: 'edit',
      diff: { added: 4, updated: 0, deleted: 0 },
    })
    const events = await db().execute<{ payload: { op: string; count: number } }>(
      sql`SELECT event->'payload' AS payload FROM ops.outbox
           WHERE type = 'dataset.rows_changed' AND event->'object'->>'id' = ${datasetId}`,
    )
    expect(events.map((row) => row.payload)).toEqual([
      expect.objectContaining({ op: 'insert', count: 4 }),
    ])
    const history = await call(fx.app, {
      url: `/datasets/${datasetId}/rows/${items[0]._id}/history`,
      as: fx.admin,
    })
    expect(history.json().items).toEqual([
      expect.objectContaining({ op: 'insert', ver: 1, previous: null }),
    ])
  })

  it('страница строк: типы значений, счётчик, сортировка, фильтр и поиск', async () => {
    const page = await rowsQuery({
      sort: [{ field: 'amount', dir: 'desc', nulls: 'last' }],
      limit: 2,
    })
    expect(page.statusCode, page.body).toBe(200)
    const body = page.json()
    expect(body.fields.slice(0, 2).map((f: { name: string }) => f.name)).toEqual(['_id', '_ver'])
    expect(body.rowCount).toBe(4)
    const [first, second] = records(body)
    expect(first).toMatchObject({ code: 'INC-0001', amount: 120.5, day: '2026-03-01' })
    expect(first?.tags).toEqual(['паводок'])
    expect(second).toMatchObject({ code: 'INC-0003', amount: 75 })

    const all = records((await rowsQuery({ limit: 10 })).json())
    expect(all.find((row) => row.code === 'INC-0004')?.point).toEqual({
      type: 'Point',
      coordinates: [71.55, 37.49],
    })

    const filtered = await rowsQuery({ where: { field: 'district', op: 'eq', value: 'Хатлон' } })
    expect(filtered.json().rowCount).toBe(2)
    const searched = await rowsQuery({ search: 'согд' })
    expect(records(searched.json()).map((row) => row.code)).toEqual(['INC-0002'])
    const offset = await rowsQuery({ limit: 2, offset: 2 })
    expect(records(offset.json()).map((row) => row.code)).toEqual(['INC-0003', 'INC-0004'])
  })

  it('проверка значений: тип, неизвестное поле, обязательное, повтор ключа', async () => {
    const bad = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/rows`,
      as: fx.admin,
      payload: { rows: [{ values: { code: 'X-1', amount: 'много', nope: 1 } }] },
    })
    expect(bad.statusCode).toBe(400)
    expect(
      bad
        .json()
        .errors.map((e: { path: string }) => e.path)
        .sort(),
    ).toEqual(['amount', 'nope'])
    const missing = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/rows`,
      as: fx.admin,
      payload: { rows: [{ values: { district: 'Согд' } }] },
    })
    expect(missing.statusCode).toBe(400)
    const duplicate = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/rows`,
      as: fx.admin,
      payload: { rows: [{ values: { code: 'INC-0001' } }] },
    })
    expect(duplicate.statusCode).toBe(409)
  })
})

describe('строки: правка и удаление', () => {
  it('правка с версией; устаревшая версия — 409 с текущими значениями и изменёнными полями', async () => {
    const [row] = records(
      (await rowsQuery({ where: { field: 'code', op: 'eq', value: 'INC-0002' } })).json(),
    )
    const id = String(row?._id)

    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${datasetId}/rows/${id}`,
      as: fx.admin,
      payload: { values: { amount: 55 }, ver: 1 },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    expect(patched.json()).toMatchObject({ _ver: 2, values: { amount: 55, district: 'Согд' } })

    const stale = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${datasetId}/rows/${id}`,
      as: fx.admin,
      payload: { values: { district: 'Хатлон' }, ver: 1 },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().data).toMatchObject({
      current: { _id: id, _ver: 2, values: { amount: 55 } },
      changedFields: ['amount'],
    })

    // Те же значения — без новой версии строки
    const same = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${datasetId}/rows/${id}`,
      as: fx.admin,
      payload: { values: { amount: 55 }, ver: 2 },
    })
    expect(same.json()._ver).toBe(2)

    const history = await call(fx.app, {
      url: `/datasets/${datasetId}/rows/${id}/history`,
      as: fx.admin,
    })
    expect(history.json().items[0]).toMatchObject({
      op: 'update',
      ver: 2,
      values: { amount: 55 },
      previous: { amount: 40 },
    })
    const fetched = await call(fx.app, { url: `/datasets/${datasetId}/rows/${id}`, as: fx.admin })
    expect(fetched.json()).toMatchObject({ _id: id, _ver: 2, values: { amount: 55 } })
  })

  it('удаление — мягкое при истории: строки нет в таблице, счётчик уменьшился', async () => {
    const [row] = records(
      (await rowsQuery({ where: { field: 'code', op: 'eq', value: 'INC-0003' } })).json(),
    )
    const removed = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/rows/delete`,
      as: fx.admin,
      payload: { ids: [String(row?._id)] },
    })
    expect(removed.json()).toEqual({ deleted: 1 })
    const page = await rowsQuery({ limit: 10 })
    expect(page.json().rowCount).toBe(3)
    const dataset = await call(fx.app, { url: `/datasets/${datasetId}`, as: fx.admin })
    expect(dataset.json().rowCount).toBe(3)
    const missing = await call(fx.app, {
      url: `/datasets/${datasetId}/rows/${String(row?._id)}`,
      as: fx.admin,
    })
    expect(missing.statusCode).toBe(404)
  })
})

describe('запросы и кэш', () => {
  it('сводка по районам; повтор — из кэша, правка данных — новый результат', async () => {
    const spec = {
      version: 1,
      source: { kind: 'dataset', id: datasetId },
      steps: [
        {
          type: 'aggregate',
          groupBy: [{ field: 'district' }],
          measures: [{ agg: 'count', alias: 'n' }],
        },
        { type: 'sort', by: [{ field: 'district', dir: 'asc' }] },
      ],
    }
    const first = await call(fx.app, {
      method: 'POST',
      url: '/queries/run',
      as: fx.admin,
      payload: { spec },
    })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().cached).toBe(false)
    expect(records(first.json())).toEqual([
      { district: 'ГБАО', n: 1 },
      { district: 'Согд', n: 1 },
      { district: 'Хатлон', n: 1 },
    ])
    const second = await call(fx.app, {
      method: 'POST',
      url: '/queries/run',
      as: fx.admin,
      payload: { spec },
    })
    expect(second.json().cached).toBe(true)

    await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/rows`,
      as: fx.admin,
      payload: { rows: [{ values: { code: 'INC-0005', district: 'Хатлон' } }] },
    })
    const third = await call(fx.app, {
      method: 'POST',
      url: '/queries/run',
      as: fx.admin,
      payload: { spec },
    })
    expect(third.json().cached).toBe(false)
    expect(records(third.json()).find((row) => row.district === 'Хатлон')?.n).toBe(2)
  })

  it('ошибка спецификации — 400 с путём проблемы', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/queries/run',
      as: fx.admin,
      payload: {
        spec: {
          version: 1,
          source: { kind: 'dataset', id: datasetId },
          steps: [{ type: 'filter', where: { field: 'missing', op: 'eq', value: 1 } }],
        },
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().data.issues[0].path).toEqual(expect.arrayContaining(['steps']))
  })
})

describe('политики строк и столбцов в таблице', () => {
  it('читатель с политикой строк видит только свой район; править строки не может', async () => {
    await addPolicy({
      table: 'dataset_row_policies',
      userId: fx.users.viewer.id,
      filter: { field: 'district', op: 'eq', value: 'Хатлон' },
    })
    const page = await rowsQuery({ limit: 10 }, fx.users.viewer)
    expect(page.statusCode, page.body).toBe(200)
    expect(new Set(records(page.json()).map((row) => row.district))).toEqual(new Set(['Хатлон']))
    expect(page.json().rowCount).toBe(2)

    const admin = await rowsQuery({ limit: 10 })
    expect(admin.json().rowCount).toBe(4)

    const write = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/rows`,
      as: fx.users.viewer,
      payload: { rows: [{ values: { code: 'V-1' } }] },
    })
    expect(write.statusCode).toBe(403)
  })

  it('маска и скрытие столбцов: значения маскируются, скрытое поле не читается', async () => {
    await addPolicy({
      table: 'dataset_column_policies',
      userId: fx.users.viewer.id,
      mode: 'mask',
      fields: ['code'],
    })
    await addPolicy({
      table: 'dataset_column_policies',
      userId: fx.users.viewer.id,
      mode: 'hide',
      fields: ['amount'],
    })
    const page = await rowsQuery({ limit: 10 }, fx.users.viewer)
    expect(page.statusCode, page.body).toBe(200)
    const names = page.json().fields.map((f: { name: string }) => f.name)
    expect(names).not.toContain('amount')
    for (const row of records(page.json())) expect(String(row.code)).toMatch(/^\*\*\*/)

    const sorted = await rowsQuery({ sort: [{ field: 'amount', dir: 'asc' }] }, fx.users.viewer)
    expect(sorted.statusCode).toBe(400)
    const history = await call(fx.app, {
      url: `/datasets/${datasetId}/rows/1/history`,
      as: fx.users.viewer,
    })
    expect(history.statusCode).toBe(403)
  })

  it('правка выключена в настройках — 403 даже владельцу; посторонний — 404', async () => {
    const settings = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${datasetId}`,
      as: fx.admin,
      payload: { settings: { editable: false } },
    })
    expect(settings.statusCode, settings.body).toBe(200)
    const write = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/rows`,
      as: fx.admin,
      payload: { rows: [{ values: { code: 'X-9' } }] },
    })
    expect(write.statusCode).toBe(403)
    const stranger = await rowsQuery({ limit: 1 }, fx.users.stranger)
    expect(stranger.statusCode).toBe(404)
  })
})
