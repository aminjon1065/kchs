import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Политики строк и столбцов датасета (03-access-model.md «Строки и столбцы
 * датасетов»): ведёт `manage+`, фильтр проверяется компилятором, изменение —
 * событие; принципалы — пользователь, роль в пространстве, «все сотрудники».
 */
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
      name: `Политики ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
        { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
        { key: 'amount', label: { ru: 'Ущерб' }, type: 'number', semantic: 'measure' },
        { key: 'day', label: { ru: 'Дата' }, type: 'date', semantic: 'time' },
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
        { code: 'A-1', district: 'Хатлон', amount: 10, day: '2026-03-01', phone: '+992900000001' },
        { code: 'A-2', district: 'Хатлон', amount: 20, day: '2026-03-02', phone: '+992900000002' },
        { code: 'A-3', district: 'Согд', amount: 30, day: '2026-03-03', phone: '+992900000003' },
        { code: 'A-4', district: 'ГБАО', amount: 40, day: '2026-03-04', phone: '+992900000004' },
      ].map((values) => ({ values })),
    },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)
})

const policies = (as = fx.admin) => call(fx.app, { url: `/datasets/${datasetId}/policies`, as })

const addRowPolicy = (payload: Record<string, unknown>, as = fx.admin) =>
  call(fx.app, { method: 'POST', url: `/datasets/${datasetId}/policies/rows`, as, payload })

const addColumnPolicy = (payload: Record<string, unknown>, as = fx.admin) =>
  call(fx.app, { method: 'POST', url: `/datasets/${datasetId}/policies/columns`, as, payload })

/** Районы и поля, которые видит пользователь в таблице датасета. */
async function visible(as = fx.users.viewer) {
  const response = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows/query`,
    as,
    payload: { limit: 100 },
  })
  expect(response.statusCode, response.body).toBe(200)
  const body = response.json() as { fields: Array<{ name: string }>; rows: unknown[][] }
  const names = body.fields.map((field) => field.name)
  const records = body.rows.map((row) => Object.fromEntries(names.map((name, i) => [name, row[i]])))
  return { names, records, districts: records.map((row) => row.district).sort() }
}

async function clearPolicies() {
  const current = (await policies()).json()
  for (const policy of current.rows) {
    const removed = await call(fx.app, {
      method: 'DELETE',
      url: `/datasets/${datasetId}/policies/rows/${policy.id}`,
      as: fx.admin,
    })
    expect(removed.statusCode, removed.body).toBe(200)
  }
  for (const policy of current.columns) {
    const removed = await call(fx.app, {
      method: 'DELETE',
      url: `/datasets/${datasetId}/policies/columns/${policy.id}`,
      as: fx.admin,
    })
    expect(removed.statusCode, removed.body).toBe(200)
  }
}

describe('политики строк', () => {
  it('добавление: список с принципалом, событие, читатель видит только свои строки', async () => {
    expect((await visible()).districts).toHaveLength(4)

    const created = await addRowPolicy({
      principal: { type: 'user', id: fx.users.viewer.id },
      filter: { field: 'district', op: 'eq', value: 'Хатлон' },
      note: '  Только своя область  ',
    })
    expect(created.statusCode, created.body).toBe(200)
    expect(created.json()).toMatchObject({
      principal: { type: 'user', id: fx.users.viewer.id, title: expect.any(String) },
      note: 'Только своя область',
    })

    const list = await policies()
    expect(list.statusCode, list.body).toBe(200)
    expect(list.json().rows).toHaveLength(1)
    expect(list.json().columns).toEqual([])

    const events = await db().execute<{ payload: Record<string, unknown> }>(
      sql`SELECT event->'payload' AS payload FROM ops.outbox
           WHERE type = 'dataset.policies_changed' AND event->'object'->>'id' = ${datasetId}`,
    )
    expect(events.map((row) => row.payload)).toEqual([
      { kind: 'rows', op: 'created', policyId: created.json().id },
    ])

    // Тот же запрос читателя — уже с политикой (кэш учитывает политики)
    expect((await visible()).districts).toEqual(['Хатлон', 'Хатлон'])
    // Владелец (manage+) видит всё
    expect((await visible(fx.admin)).districts).toHaveLength(4)
    // Участник пространства не попал ни под одну политику — строк нет
    expect((await visible(fx.users.member)).districts).toEqual([])
  })

  it('правка фильтра и удаление: видимость меняется сразу', async () => {
    const [policy] = (await policies()).json().rows
    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${datasetId}/policies/rows/${policy.id}`,
      as: fx.admin,
      payload: { filter: { field: 'amount', op: 'gte', value: 30 }, note: null },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    expect(patched.json().note).toBeNull()
    expect((await visible()).districts).toEqual(['ГБАО', 'Согд'])

    await clearPolicies()
    expect((await visible()).districts).toHaveLength(4)
    expect((await visible(fx.users.member)).districts).toHaveLength(4)
  })

  it('принципалы-группы: роль в пространстве и «все сотрудники»; политики через OR', async () => {
    const byRole = await addRowPolicy({
      principal: { type: 'space_role', id: `${fx.spaceId}:viewer` },
      filter: { field: 'district', op: 'eq', value: 'Согд' },
    })
    expect(byRole.statusCode, byRole.body).toBe(200)
    expect(byRole.json().principal.title).not.toBe(`${fx.spaceId}:viewer`)
    // Роль «не ниже читателя» — и участник-редактор под неё попадает
    expect((await visible()).districts).toEqual(['Согд'])
    expect((await visible(fx.users.member)).districts).toEqual(['Согд'])

    const everyone = await addRowPolicy({
      principal: { type: 'everyone', id: '*' },
      filter: { field: 'district', op: 'eq', value: 'ГБАО' },
    })
    expect(everyone.statusCode, everyone.body).toBe(200)
    expect((await visible()).districts).toEqual(['ГБАО', 'Согд'])
    await clearPolicies()
  })

  it('проверка фильтра компилятором: неизвестное поле, оператор, параметр, гостевая ссылка', async () => {
    const unknown = await addRowPolicy({
      principal: { type: 'user', id: fx.users.viewer.id },
      filter: { field: 'region', op: 'eq', value: 'Хатлон' },
    })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json().detail).toContain('region')

    const operator = await addRowPolicy({
      principal: { type: 'user', id: fx.users.viewer.id },
      filter: { field: 'district', op: 'relative', value: { unit: 'day', from: -1, to: 0 } },
    })
    expect(operator.statusCode).toBe(400)

    const param = await addRowPolicy({
      principal: { type: 'user', id: fx.users.viewer.id },
      filter: { field: 'district', op: 'eq', value: '@param:region' },
    })
    expect(param.statusCode).toBe(400)
    expect(param.json().detail).toContain('параметры')

    const link = await addRowPolicy({
      principal: { type: 'link', id: 'token' },
      filter: { field: 'district', op: 'eq', value: 'Хатлон' },
    })
    expect(link.statusCode).toBe(400)

    // Макрос пользователя допустим
    const macro = await addRowPolicy({
      principal: { type: 'user', id: fx.users.viewer.id },
      filter: { field: 'code', op: 'eq', value: '@me' },
    })
    expect(macro.statusCode, macro.body).toBe(200)
    expect((await visible()).districts).toEqual([])
    await clearPolicies()
  })
})

describe('политики столбцов', () => {
  it('скрытие и маска; правка набора полей; неизвестное поле — 400', async () => {
    const hidden = await addColumnPolicy({
      principal: { type: 'user', id: fx.users.viewer.id },
      mode: 'hide',
      fields: ['amount', 'amount'],
    })
    expect(hidden.statusCode, hidden.body).toBe(200)
    expect(hidden.json().fields).toEqual(['amount'])
    const masked = await addColumnPolicy({
      principal: { type: 'space_role', id: `${fx.spaceId}:viewer` },
      mode: 'mask',
      fields: ['phone'],
    })
    expect(masked.statusCode, masked.body).toBe(200)

    const seen = await visible()
    expect(seen.names).not.toContain('amount')
    for (const row of seen.records) expect(String(row.phone)).toMatch(/^\*\*\*/)
    const schema = await call(fx.app, { url: `/datasets/${datasetId}`, as: fx.users.viewer })
    expect(schema.json().fields.map((field: { key: string }) => field.key)).not.toContain('amount')

    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${datasetId}/policies/columns/${hidden.json().id}`,
      as: fx.admin,
      payload: { fields: ['day'] },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    const after = await visible()
    expect(after.names).toContain('amount')
    expect(after.names).not.toContain('day')

    const unknown = await addColumnPolicy({
      principal: { type: 'user', id: fx.users.viewer.id },
      mode: 'hide',
      fields: ['nope'],
    })
    expect(unknown.statusCode).toBe(400)
    await clearPolicies()
  })
})

describe('права на политики и связь со схемой', () => {
  it('политики ведёт только manage+: читатель и редактор — 403, посторонний — 404', async () => {
    expect((await policies(fx.users.viewer)).statusCode).toBe(403)
    expect((await policies(fx.users.member)).statusCode).toBe(403)
    expect((await policies(fx.users.stranger)).statusCode).toBe(404)
    const byEditor = await addRowPolicy(
      {
        principal: { type: 'user', id: fx.users.viewer.id },
        filter: { field: 'district', op: 'eq', value: 'Согд' },
      },
      fx.users.member,
    )
    expect(byEditor.statusCode).toBe(403)
    const missing = await call(fx.app, {
      method: 'DELETE',
      url: `/datasets/${datasetId}/policies/rows/00000000-0000-7000-8000-000000000000`,
      as: fx.admin,
    })
    expect(missing.statusCode).toBe(404)
  })

  it('поле из политики строк не удаляется и не меняет тип на несовместимый; из политики столбцов — убирается', async () => {
    const rowPolicy = await addRowPolicy({
      principal: { type: 'user', id: fx.users.viewer.id },
      filter: { field: 'day', op: 'relative', value: { unit: 'year', from: -100, to: 100 } },
    })
    expect(rowPolicy.statusCode, rowPolicy.body).toBe(200)
    const columnPolicy = await addColumnPolicy({
      principal: { type: 'user', id: fx.users.viewer.id },
      mode: 'mask',
      fields: ['phone'],
    })
    expect(columnPolicy.statusCode, columnPolicy.body).toBe(200)

    const remove = await call(fx.app, {
      method: 'DELETE',
      url: `/datasets/${datasetId}/fields/day`,
      as: fx.admin,
    })
    expect(remove.statusCode).toBe(409)
    const convert = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/fields/day/convert`,
      as: fx.admin,
      payload: { type: 'text', dryRun: true },
    })
    expect(convert.statusCode).toBe(409)

    const removePhone = await call(fx.app, {
      method: 'DELETE',
      url: `/datasets/${datasetId}/fields/phone`,
      as: fx.admin,
    })
    expect(removePhone.statusCode, removePhone.body).toBe(200)
    const list = (await policies()).json()
    expect(list.columns).toEqual([])
    expect(list.rows).toHaveLength(1)
    await clearPolicies()
  })
})
