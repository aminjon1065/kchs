import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/** Профиль столбца и политики строк и столбцов (P1-E03 S02, 03-access-model.md). */
registerLifecycle()

let fx: TestContext
let datasetId: string
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Профиль ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
        { key: 'amount', label: { ru: 'Сумма' }, type: 'number', semantic: 'measure' },
        { key: 'kind', label: { ru: 'Вид' }, type: 'text', semantic: 'category' },
        { key: 'day', label: { ru: 'Дата' }, type: 'date', semantic: 'time' },
      ],
      primaryKey: ['code'],
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  datasetId = created.json().id

  const [meta] = await db().execute<{ physical_table: string }>(
    sql`SELECT physical_table FROM datasets WHERE id = ${datasetId}`,
  )
  const table = sql.raw(`ds."${meta?.physical_table}"`)
  // 100 чисел, 3 пустых; виды A×3, B×2, C×1; даты — январь 2026
  await db().execute(
    sql`INSERT INTO ${table} (c_1, c_2, c_3, c_4)
        SELECT 'R-' || g, CASE WHEN g <= 100 THEN g END,
               CASE WHEN g <= 3 THEN 'A' WHEN g <= 5 THEN 'B' WHEN g = 6 THEN 'C' END,
               date '2026-01-01' + (g % 31)
          FROM generate_series(1, 103) g`,
  )
  await db().execute(sql`UPDATE datasets SET row_count = 103 WHERE id = ${datasetId}`)
})

const profile = (key: string, as = fx.admin) =>
  call(fx.app, { url: `/datasets/${datasetId}/fields/${key}/profile`, as })

async function addPolicy(
  table: 'dataset_row_policies' | 'dataset_column_policies',
  values: Record<string, unknown>,
) {
  if (table === 'dataset_row_policies') {
    await db().execute(
      sql`INSERT INTO dataset_row_policies (id, dataset_id, principal_type, principal_id, filter)
          VALUES (gen_random_uuid(), ${datasetId}, ${values.type}, ${values.id}, ${JSON.stringify(values.filter)}::jsonb)`,
    )
  } else {
    await db().execute(
      sql`INSERT INTO dataset_column_policies (id, dataset_id, principal_type, principal_id, mode, fields)
          VALUES (gen_random_uuid(), ${datasetId}, ${values.type}, ${values.id}, ${values.mode},
                  ${`{${(values.fields as string[]).join(',')}}`}::text[])`,
    )
  }
}

describe('профиль столбца', () => {
  it('число: пустые, различные, диапазон, среднее, 20 интервалов', async () => {
    const response = await profile('amount')
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({
      field: 'amount',
      type: 'number',
      rows: 103,
      sampled: false,
      empty: 3,
      distinct: 100,
      masked: false,
      min: '1',
      max: '100',
      mean: 50.5,
      top: [],
    })
    expect(body.histogram).toHaveLength(20)
    expect(body.histogram.reduce((sum: number, bin: { count: number }) => sum + bin.count, 0)).toBe(
      100,
    )
    expect(body.histogram[0]).toMatchObject({ from: '1' })
    expect(body.histogram[19]).toMatchObject({ to: '100' })
  })

  it('текст: частые значения по убыванию; дата: диапазон в ISO', async () => {
    const kind = (await profile('kind')).json()
    expect(kind).toMatchObject({ empty: 97, distinct: 3 })
    expect(kind.top).toEqual([
      { value: 'A', count: 3 },
      { value: 'B', count: 2 },
      { value: 'C', count: 1 },
    ])
    const day = (await profile('day')).json()
    expect(day).toMatchObject({ min: '2026-01-01', max: '2026-01-31' })
    expect(day.histogram[0].from).toBe('2026-01-01')
  })

  it('профиль кэшируется по версии датасета', async () => {
    const first = (await profile('code')).json()
    const second = (await profile('code')).json()
    expect(second.computedAt).toBe(first.computedAt)
    expect(first.top).toHaveLength(10)
  })
})

describe('политики столбцов и строк', () => {
  it('маскируемое поле: читателю — только счётчики; управляющему — всё', async () => {
    await addPolicy('dataset_column_policies', {
      type: 'user',
      id: fx.users.viewer.id,
      mode: 'mask',
      fields: ['kind'],
    })
    const masked = await profile('kind', fx.users.viewer)
    expect(masked.statusCode, masked.body).toBe(200)
    expect(masked.json()).toMatchObject({ masked: true, distinct: 3, top: [], min: null })
    expect((await profile('kind')).json()).toMatchObject({ masked: false })
  })

  it('скрытое поле: нет в схеме у читателя, профиль — 404', async () => {
    await addPolicy('dataset_column_policies', {
      type: 'user',
      id: fx.users.viewer.id,
      mode: 'hide',
      fields: ['amount', 'code'],
    })
    const record = await call(fx.app, { url: `/datasets/${datasetId}`, as: fx.users.viewer })
    expect(record.statusCode).toBe(200)
    expect(record.json().fields.map((field: { key: string }) => field.key)).toEqual(['kind', 'day'])
    expect(record.json().primaryKey).toEqual([])
    expect((await profile('amount', fx.users.viewer)).statusCode).toBe(404)
    // Владелец видит всё
    const full = await call(fx.app, { url: `/datasets/${datasetId}`, as: fx.admin })
    expect(full.json().fields).toHaveLength(4)
  })

  it('политика строк не для читателя: строк нет — профиль недоступен', async () => {
    await addPolicy('dataset_row_policies', {
      type: 'user',
      id: fx.users.member.id,
      filter: { op: 'eq', field: 'kind', value: 'A' },
    })
    expect((await profile('day', fx.users.viewer)).statusCode).toBe(403)
    expect((await profile('day')).statusCode).toBe(200)
  })
})
