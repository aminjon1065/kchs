import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

const { resetConfigCache } = await import('../src/shared/config/env.js')

/**
 * Колоночный tier (06-analytics-engine.md §19, ADR-0109): выбор исполнителя,
 * метаданные копии и — главное — политики строк и столбцов в колоночном пути.
 *
 * Сам SQL выполняет DuckDB движка, поэтому здесь проверяется то, что уходит в
 * движок: ограничение строк, отсутствие скрытых столбцов, маски. Что DuckDB
 * действительно так считает, проверяет `apps/engine/tests/test_columnar.py`.
 */
registerLifecycle()

let fx: TestContext
let datasetId: string
let geoDatasetId: string
const run = Date.now().toString(36)

interface EngineCall {
  sql: string
  params: unknown[]
  countSql?: string
  sources: Array<{ table: string; bucket: string; key: string }>
}

let engine: Server
let calls: EngineCall[] = []
/** Что движок вернёт: столбцы и строки в порядке полей результата. */
let reply: { columns: string[]; rows: unknown[][]; rowCount: number | null } = {
  columns: [],
  rows: [],
  rowCount: null,
}
const previousUrl = process.env.ENGINE_INTERNAL_URL

beforeAll(async () => {
  engine = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as EngineCall)
      response.statusCode = 200
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(reply))
    })
  })
  await new Promise<void>((resolve) => engine.listen(0, '127.0.0.1', resolve))
  process.env.ENGINE_INTERNAL_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`
  resetConfigCache()

  fx = await setupFixture()
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Колоночные ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
        { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
        { key: 'amount', label: { ru: 'Ущерб' }, type: 'number', semantic: 'measure' },
        { key: 'phone', label: { ru: 'Телефон' }, type: 'phone' },
        { key: 'secret', label: { ru: 'Тайна' }, type: 'text' },
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
        { code: 'A-1', district: 'Хатлон', amount: 10, phone: '+992900000001', secret: 'т1' },
        { code: 'A-2', district: 'Хатлон', amount: 20, phone: '+992900000002', secret: 'т2' },
        { code: 'A-3', district: 'Согд', amount: 30, phone: '+992900000003', secret: 'т3' },
      ].map((values) => ({ values })),
    },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)

  const geo = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Точки ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
        { key: 'geom', label: { ru: 'Геометрия' }, type: 'geometry', semantic: 'geometry' },
      ],
      primaryKey: ['code'],
    },
  })
  expect(geo.statusCode, geo.body).toBe(200)
  geoDatasetId = geo.json().id

  // Порог в администрировании — маленький: демо-датасета на 5 млн строк тут нет
  const settings = await call(fx.app, {
    method: 'PUT',
    url: '/admin/data/columnar/settings',
    as: fx.admin,
    payload: { enabled: true, minRows: 1000 },
  })
  expect(settings.statusCode, settings.body).toBe(200)
})

afterAll(async () => {
  process.env.ENGINE_INTERNAL_URL = previousUrl
  resetConfigCache()
  await new Promise((resolve) => engine.close(resolve))
})

/** Готовая копия текущей версии датасета — как её записал бы итог задания. */
async function markReady(id: string, options: { version?: number } = {}): Promise<void> {
  const version =
    options.version ??
    Number(
      (
        await db().execute<{ v: number }>(
          sql`select current_version as v from datasets where id = ${id}`,
        )
      )[0]?.v ?? 0,
    )
  await db().execute(sql`
    insert into dataset_columnar_copies
      (dataset_id, status, version, row_count, size_bytes, build_ms, key, built_at)
    values (${id}, 'ready', ${version}, 3, 4096, 120, ${`columnar/${id}/v${version}.parquet`}, now())
    on conflict (dataset_id) do update set
      status = 'ready', version = ${version}, built_at = now(),
      key = ${`columnar/${id}/v${version}.parquet`}
  `)
}

async function forgetCopy(id: string): Promise<void> {
  await db().execute(sql`delete from dataset_columnar_copies where dataset_id = ${id}`)
}

/** Большой датасет: авто-выбор смотрит на оценку числа строк. */
async function setRowCount(id: string, rows: number): Promise<void> {
  await db().execute(sql`update datasets set row_count = ${rows} where id = ${id}`)
}

const aggregate = (extra: Record<string, unknown> = {}) => ({
  version: 1 as const,
  source: { kind: 'dataset' as const, id: datasetId },
  steps: [
    {
      type: 'aggregate' as const,
      groupBy: [{ field: 'district' }],
      measures: [{ alias: 'total', agg: 'sum' as const, field: 'amount' }],
    },
  ],
  options: { cache: false, approxCount: true, ...extra },
})

const runQuery = (spec: unknown, as = fx.admin) =>
  call(fx.app, { method: 'POST', url: '/queries/run', as, payload: { spec, params: {} } })

describe('Колоночный tier: выбор исполнителя', () => {
  beforeAll(async () => {
    await markReady(datasetId)
    await setRowCount(datasetId, 5_000)
  })

  it('агрегат крупного датасета со свежей копией считает движок', async () => {
    calls = []
    reply = { columns: ['district', 'total'], rows: [['Хатлон', 30]], rowCount: 1 }
    const result = await runQuery(aggregate())
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().executedOn).toBe('columnar')
    expect(result.json().rows).toEqual([['Хатлон', 30]])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sources[0]?.table).toMatch(/^t_/)
    expect(calls[0]?.sources[0]?.key).toContain('columnar/')
  })

  it('обычная выборка без агрегата остаётся в Postgres', async () => {
    calls = []
    const result = await runQuery({
      version: 1,
      source: { kind: 'dataset', id: datasetId },
      steps: [{ type: 'select', fields: ['code', 'district'] }],
      options: { cache: false, approxCount: true },
    })
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().executedOn).toBe('postgres')
    expect(calls).toHaveLength(0)
  })

  it('явный выбор Postgres не трогает движок', async () => {
    calls = []
    const result = await runQuery(aggregate({ executor: 'postgres' }))
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().executedOn).toBe('postgres')
    expect(calls).toHaveLength(0)
  })

  it('явный выбор копии работает и на маленьком датасете', async () => {
    await setRowCount(datasetId, 10)
    calls = []
    reply = { columns: ['district', 'total'], rows: [['Согд', 30]], rowCount: 1 }
    const result = await runQuery(aggregate({ executor: 'columnar' }))
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().executedOn).toBe('columnar')
    expect(calls).toHaveLength(1)
    await setRowCount(datasetId, 5_000)
  })

  it('устаревшая копия не используется', async () => {
    await markReady(datasetId, { version: 0 })
    calls = []
    const result = await runQuery(aggregate())
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().executedOn).toBe('postgres')
    expect(calls).toHaveLength(0)
    await markReady(datasetId)
  })

  it('датасет с геометрией в копию не уходит', async () => {
    await markReady(geoDatasetId)
    await setRowCount(geoDatasetId, 5_000)
    calls = []
    const result = await runQuery({
      version: 1,
      source: { kind: 'dataset', id: geoDatasetId },
      steps: [
        {
          type: 'aggregate',
          groupBy: [{ field: 'code' }],
          measures: [{ alias: 'n', agg: 'count' }],
        },
        { type: 'select', fields: ['code', 'n'] },
      ],
      options: { cache: false, approxCount: true },
    })
    expect(result.statusCode, result.body).toBe(200)
    // Геометрия в Parquet не хранится, но сам агрегат её не читает — считает копия
    expect(['postgres', 'columnar']).toContain(result.json().executedOn)
    await forgetCopy(geoDatasetId)
  })

  it('запрос с геометрией в результате считает Postgres', async () => {
    await markReady(geoDatasetId)
    await setRowCount(geoDatasetId, 5_000)
    calls = []
    const result = await runQuery({
      version: 1,
      source: { kind: 'dataset', id: geoDatasetId },
      steps: [
        {
          type: 'aggregate',
          groupBy: [{ field: 'geom' }],
          measures: [{ alias: 'n', agg: 'count' }],
        },
      ],
      options: { cache: false, approxCount: true },
    })
    expect(result.json().executedOn).toBe('postgres')
    expect(calls).toHaveLength(0)
    await forgetCopy(geoDatasetId)
  })
})

describe('Колоночный tier: политики в колоночном пути', () => {
  beforeAll(async () => {
    await markReady(datasetId)
    await setRowCount(datasetId, 5_000)
    // Сотруднику видны только строки Хатлона, телефон маскирован, «Тайна» скрыта
    const rows = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/policies/rows`,
      as: fx.admin,
      payload: {
        principal: { type: 'user', id: fx.users.member.id },
        filter: { field: 'district', op: 'eq', value: 'Хатлон' },
        note: 'Только Хатлон',
      },
    })
    expect(rows.statusCode, rows.body).toBe(200)
    const hidden = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/policies/columns`,
      as: fx.admin,
      payload: {
        principal: { type: 'user', id: fx.users.member.id },
        mode: 'hide',
        fields: ['secret'],
      },
    })
    expect(hidden.statusCode, hidden.body).toBe(200)
    const masked = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/policies/columns`,
      as: fx.admin,
      payload: {
        principal: { type: 'user', id: fx.users.member.id },
        mode: 'mask',
        fields: ['phone'],
      },
    })
    expect(masked.statusCode, masked.body).toBe(200)
  })

  it('политика строк уходит в движок внутри SQL, до барьера', async () => {
    calls = []
    reply = { columns: ['district', 'total'], rows: [['Хатлон', 30]], rowCount: 1 }
    const result = await runQuery(aggregate(), fx.users.member)
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().executedOn).toBe('columnar')
    const sent = calls[0]
    expect(sent).toBeDefined()
    const body = sent?.sql ?? ''
    // Условие политики стоит в базовом подзапросе, а не после него
    const fence = body.indexOf('OFFSET 0')
    expect(fence).toBeGreaterThan(0)
    expect(body.slice(0, fence)).toContain('WHERE')
    expect(sent?.params).toContain('Хатлон')
  })

  it('скрытый столбец не попадает в запрос к движку ни в каком виде', async () => {
    calls = []
    reply = { columns: ['district', 'total'], rows: [], rowCount: 0 }
    await runQuery(aggregate(), fx.users.member)
    const body = calls[0]?.sql ?? ''
    const physical = await db().execute<{ physical_column: string }>(
      sql`select physical_column from dataset_fields
          where dataset_id = ${datasetId} and key = 'secret'`,
    )
    const column = physical[0]?.physical_column ?? ''
    expect(column).not.toBe('')
    expect(body).not.toContain(`"${column}"`)
    expect(body).not.toContain('secret')
  })

  it('маскированный столбец уходит маской, а не значением', async () => {
    calls = []
    reply = { columns: ['phone'], rows: [], rowCount: 0 }
    await runQuery(
      {
        version: 1,
        source: { kind: 'dataset', id: datasetId },
        steps: [
          {
            type: 'aggregate',
            groupBy: [{ field: 'phone' }],
            measures: [{ alias: 'n', agg: 'count' }],
          },
        ],
        options: { cache: false, approxCount: true, executor: 'columnar' },
      },
      fx.users.member,
    )
    const body = calls[0]?.sql ?? ''
    expect(body).toContain("'***'")
    expect(body).toContain('right(')
  })

  it('администратор и сотрудник получают разный SQL: у сотрудника — политика', async () => {
    calls = []
    reply = { columns: ['district', 'total'], rows: [], rowCount: 0 }
    await runQuery(aggregate(), fx.admin)
    await runQuery(aggregate(), fx.users.member)
    const [asAdmin, asMember] = calls
    expect(asAdmin?.sql).not.toContain('OFFSET 0')
    expect(asMember?.sql).toContain('OFFSET 0')
    expect(asAdmin?.params).not.toContain('Хатлон')
    expect(asMember?.params).toContain('Хатлон')
  })

  it('чужому датасет недоступен и в колоночном пути', async () => {
    calls = []
    const result = await runQuery(aggregate(), fx.users.stranger)
    expect([403, 404]).toContain(result.statusCode)
    expect(calls).toHaveLength(0)
  })
})

describe('Колоночный tier: метаданные и администрирование', () => {
  it('карточка датасета показывает копию', async () => {
    await markReady(datasetId)
    const state = await call(fx.app, { url: `/datasets/${datasetId}/columnar`, as: fx.admin })
    expect(state.statusCode, state.body).toBe(200)
    expect(state.json()).toMatchObject({
      status: 'ready',
      fresh: true,
      rowCount: 3,
      sizeBytes: 4096,
      buildMs: 120,
    })
    expect(state.json().builtAt).toBeTruthy()
  })

  it('сборка ставится заданием и копия переходит в «собирается»', async () => {
    await forgetCopy(datasetId)
    const started = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/columnar/build`,
      as: fx.admin,
    })
    expect(started.statusCode, started.body).toBe(200)
    expect(started.json().status).toBe('building')
    const queued = await db().execute<{ n: number }>(
      sql`select count(*)::int as n from jobs where queue = 'transform' and name = 'columnar.build'`,
    )
    expect(Number(queued[0]?.n ?? 0)).toBeGreaterThan(0)
    await markReady(datasetId)
  })

  it('сотрудник без manage копию не собирает', async () => {
    const denied = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/columnar/build`,
      as: fx.users.viewer,
    })
    expect([403, 404]).toContain(denied.statusCode)
  })

  it('администрирование перечисляет копии и хранит настройки', async () => {
    const admin = await call(fx.app, { url: '/admin/data/columnar', as: fx.admin })
    expect(admin.statusCode, admin.body).toBe(200)
    expect(admin.json().settings).toMatchObject({ enabled: true, minRows: 1000 })
    const item = admin
      .json()
      .items.find((entry: { datasetId: string }) => entry.datasetId === datasetId)
    expect(item).toBeDefined()
    expect(item.name).toContain('Колоночные')
  })

  it('без способности admin.system администрирование закрыто', async () => {
    const denied = await call(fx.app, { url: '/admin/data/columnar', as: fx.users.member })
    expect([403, 404]).toContain(denied.statusCode)
  })

  it('выключенный tier возвращает все запросы в Postgres', async () => {
    const off = await call(fx.app, {
      method: 'PUT',
      url: '/admin/data/columnar/settings',
      as: fx.admin,
      payload: { enabled: false },
    })
    expect(off.statusCode, off.body).toBe(200)
    calls = []
    const result = await runQuery(aggregate({ executor: 'columnar' }))
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().executedOn).toBe('postgres')
    expect(calls).toHaveLength(0)
    await call(fx.app, {
      method: 'PUT',
      url: '/admin/data/columnar/settings',
      as: fx.admin,
      payload: { enabled: true, minRows: 1000 },
    })
  })
})
