import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  redis,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * SQL-лаборатория (06-analytics-engine.md §6, ADR-0052): сырой SELECT по
 * названиям датасетов и подписям полей, с политиками пользователя; системные
 * таблицы и опасные функции отклоняются с позицией в тексте.
 */
registerLifecycle()

const { SpaceService } = await import('../src/kernel/spaces/service.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext
let analyst: TestUser
let datasetId: string
const run = Date.now().toString(36)
const table = `Инциденты_${run}`

beforeAll(async () => {
  fx = await setupFixture()
  analyst = await createUser(fx.app, 'sql_analyst_test', ['employee', 'data_steward'])
  await db().transaction((tx) =>
    SpaceService.addMember(tx, systemCtx('test'), fx.spaceId, analyst.id, 'viewer'),
  )
  await redis().del(`kchs:principals:${analyst.id}`)

  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: table,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
        { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
        { key: 'amount', label: { ru: 'Ущерб' }, type: 'number', semantic: 'measure' },
        { key: 'phone', label: { ru: 'Телефон' }, type: 'text' },
      ],
      primaryKey: ['code'],
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
        ['S-1', 'Хатлон', 10],
        ['S-2', 'Хатлон', 20],
        ['S-3', 'Согд', 30],
      ].map(([code, district, amount]) => ({
        values: { code, district, amount, phone: `+99290000000${String(code).slice(2)}` },
      })),
    },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)
  for (const [kind, payload] of [
    ['rows', { filter: { field: 'district', op: 'eq', value: 'Хатлон' } }],
    ['columns', { mode: 'hide', fields: ['amount'] }],
    ['columns', { mode: 'mask', fields: ['phone'] }],
  ] as const) {
    const response = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/policies/${kind}`,
      as: fx.admin,
      payload: { principal: { type: 'user', id: analyst.id }, ...payload },
    })
    expect(response.statusCode, response.body).toBe(200)
  }
})

const runSql = (sql: string, as: TestUser = analyst, params: Record<string, unknown> = {}) =>
  call(fx.app, { method: 'POST', url: '/sql/run', as, payload: { sql, params } })

function records(body: { fields: Array<{ name: string }>; rows: unknown[][] }) {
  return body.rows.map((row) => Object.fromEntries(body.fields.map((f, i) => [f.name, row[i]])))
}

describe('SQL-лаборатория: политики и имена', () => {
  it('SELECT * по названию датасета: только свои строки, без скрытого поля, телефон маской', async () => {
    const response = await runSql(`SELECT * FROM "${table}" ORDER BY 1`)
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json()
    expect(body.fields.map((f: { name: string }) => f.name)).toEqual(['code', 'district', 'phone'])
    const rows = records(body)
    expect(rows.map((row) => row.district)).toEqual(['Хатлон', 'Хатлон'])
    for (const row of rows) expect(String(row.phone)).toMatch(/^\*\*\*/)

    // Владелец видит всё
    const own = await runSql(`SELECT count(*) AS n FROM "${table}"`, fx.admin)
    expect(own.json().rows).toEqual([[3]])
  })

  it('подписи полей, агрегаты, параметры', async () => {
    const grouped = await runSql(
      `SELECT Район, count(*) AS n FROM ${table} WHERE Район = {{район}} GROUP BY Район`,
      analyst,
      { район: 'Хатлон' },
    )
    expect(grouped.statusCode, grouped.body).toBe(200)
    expect(grouped.json().rows).toEqual([['Хатлон', 2]])
    const types = grouped.json().fields.map((f: { type: string }) => f.type)
    expect(types).toEqual(['text', 'integer'])
  })

  it('скрытое поле, системные таблицы, опасные функции — 400 с позицией', async () => {
    const hidden = await runSql(`SELECT Ущерб FROM ${table}`)
    expect(hidden.statusCode).toBe(400)
    expect(hidden.json().data.issues[0].position).toBe(7)

    const users = await runSql('SELECT * FROM public.users')
    expect(users.statusCode).toBe(400)
    expect(users.json().data.issues[0].position).toBeGreaterThanOrEqual(14)

    const sleep = await runSql('SELECT pg_sleep(5)')
    expect(sleep.statusCode).toBe(400)
    const write = await runSql(`DELETE FROM ${table}`)
    expect(write.statusCode).toBe(400)
  })

  it('ошибка выполнения — понятное сообщение с позицией', async () => {
    const response = await runSql(`SELECT count(*) / 0 FROM ${table}`)
    expect(response.statusCode).toBe(400)
    expect(response.json().detail).toBe('Деление на ноль')
  })

  it('без способности data.sql — 403; подсказки схемы без скрытых полей', async () => {
    expect((await runSql('SELECT 1', fx.users.viewer)).statusCode).toBe(403)
    expect((await call(fx.app, { url: '/sql/schema', as: fx.users.viewer })).statusCode).toBe(403)

    const schema = await call(fx.app, { url: '/sql/schema', as: analyst })
    expect(schema.statusCode, schema.body).toBe(200)
    const own = schema.json().tables.find((item: { id: string }) => item.id === datasetId) as {
      name: string
      columns: Array<{ key: string }>
    }
    expect(own.name).toBe(table)
    expect(own.columns.map((column) => column.key)).toEqual(['code', 'district', 'phone'])
  })

  it('неизвестная таблица и одноимённые датасеты — понятная ошибка', async () => {
    const unknown = await runSql('SELECT * FROM "Нет такого"')
    expect(unknown.statusCode).toBe(400)

    const twin = await call(fx.app, {
      method: 'POST',
      url: '/datasets',
      as: fx.admin,
      payload: {
        name: table,
        spaceId: fx.spaceId,
        fields: [{ key: 'code', label: { ru: 'Код' }, type: 'identifier' }],
      },
    })
    expect(twin.statusCode, twin.body).toBe(200)
    const ambiguous = await runSql(`SELECT count(*) FROM "${table}"`)
    expect(ambiguous.statusCode).toBe(400)
    expect(ambiguous.json().detail).toContain('Несколько доступных датасетов')
  })
})
