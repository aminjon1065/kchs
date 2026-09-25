import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Источники датасетов из внешних БД (P5-E03, ADR-0107): подключение —
 * интеграция с зашифрованным паролем, выборка читается через API, загрузка
 * идёт заданием через staging и даёт новую версию датасета. Внешней базой в
 * тесте служит та же тестовая база: механика подключения от этого не меняется.
 */
registerLifecycle()

const { SourceService } = await import('../src/modules/data/domain/source-service.js')
const { JobService } = await import('../src/kernel/jobs/service.js')
const { config } = await import('../src/shared/config/index.js')
const { resetConfigCache } = await import('../src/shared/config/env.js')

let fx: TestContext
let integrationId = ''
const run = Date.now().toString(36)
/** Таблица «внешней» базы — в своей схеме: привилегии public ведёт grants.ts. */
const schema = 'ext_test'
const table = `ext_demo_${run}`

/** Параметры подключения к тестовой базе — она же «внешняя» для источника. */
function connection() {
  const url = new URL(config().DATABASE_URL)
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.replace(/^\//, ''),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    schema: 'public',
  }
}

async function runJob(jobId: string) {
  const [row] = await db().execute<{ payload: { sourceId: string; runId: string } }>(
    sql`SELECT payload FROM jobs WHERE id = ${jobId}`,
  )
  await JobService.start(jobId)
  const result = await SourceService.execute(row?.payload as never, {
    recordId: jobId,
    progress: async () => undefined,
  })
  await JobService.finish(jobId, result)
  return result
}

beforeAll(async () => {
  fx = await setupFixture()
  await db().execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS ${schema}`))
  await db().execute(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS ${schema}.${table} (id integer primary key, name text, updated_at timestamptz)`,
    ),
  )
  await db().execute(
    sql.raw(
      `INSERT INTO ${schema}.${table} (id, name, updated_at) VALUES
         (1, 'первая', '2026-01-01T00:00:00Z'),
         (2, 'вторая', '2026-02-01T00:00:00Z')
       ON CONFLICT (id) DO NOTHING`,
    ),
  )

  const params = connection()
  const created = await call(fx.app, {
    method: 'POST',
    url: '/integrations',
    as: fx.admin,
    payload: {
      key: `external-db-${run}`,
      kind: 'postgres',
      name: `Внешняя база ${run}`,
      config: {
        host: params.host,
        port: params.port,
        database: params.database,
        user: params.user,
        schema: params.schema,
      },
      secrets: { password: params.password },
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  integrationId = created.json().id
})

describe('подключение к внешней базе', () => {
  it('«Проверить соединение» отвечает и пароль наружу не отдаётся', async () => {
    const check = await call(fx.app, {
      method: 'POST',
      url: `/integrations/${integrationId}/check`,
      as: fx.admin,
    })
    expect(check.statusCode, check.body).toBe(200)
    expect(check.json().ok).toBe(true)

    const record = await call(fx.app, {
      method: 'GET',
      url: `/integrations/${integrationId}`,
      as: fx.admin,
    })
    expect(record.statusCode, record.body).toBe(200)
    expect(record.json().secretKeys).toEqual(['password'])
    expect(record.body).not.toContain(connection().password)
  })

  it('предпросмотр выборки отдаёт столбцы с типами и строки', async () => {
    const preview = await call(fx.app, {
      method: 'POST',
      url: '/sources/preview',
      as: fx.admin,
      payload: {
        integrationId,
        query: { kind: 'table', schema, table },
        limit: 10,
      },
    })
    expect(preview.statusCode, preview.body).toBe(200)
    const result = preview.json() as {
      columns: Array<{ name: string; type: string; key?: string }>
      rows: unknown[][]
    }
    expect(result.columns.map((column) => column.name)).toEqual(['id', 'name', 'updated_at'])
    expect(result.columns[0]?.type).toBe('integer')
    expect(result.rows).toHaveLength(2)
  })

  it('медленная выборка прерывается по потолку времени с понятной ошибкой (N79)', async () => {
    process.env.EXTERNAL_DB_TIMEOUT_MS = '1000'
    resetConfigCache()
    try {
      const started = Date.now()
      const preview = await call(fx.app, {
        method: 'POST',
        url: '/sources/preview',
        as: fx.admin,
        payload: {
          integrationId,
          query: { kind: 'sql', sql: 'SELECT pg_sleep(5) AS slept' },
          limit: 1,
        },
      })
      expect(preview.statusCode, preview.body).toBe(504)
      expect(preview.body).toContain('не ответила вовремя')
      expect(Date.now() - started).toBeLessThan(4500)
    } finally {
      delete process.env.EXTERNAL_DB_TIMEOUT_MS
      resetConfigCache()
    }
  })

  it('рядовой сотрудник выборку не читает', async () => {
    const preview = await call(fx.app, {
      method: 'POST',
      url: '/sources/preview',
      as: fx.users.member,
      payload: { integrationId, query: { kind: 'table', schema, table }, limit: 10 },
    })
    expect(preview.statusCode).toBe(403)
  })
})

describe('источник: снимок и инкремент', () => {
  let sourceId = ''
  let datasetId = ''

  it('создание заводит датасет-приёмник', async () => {
    const columns = [
      { name: 'id', nativeType: '23', type: 'integer', key: 'id' },
      { name: 'name', nativeType: '25', type: 'text', key: 'name' },
      { name: 'updated_at', nativeType: '1184', type: 'datetime', key: 'updated_at' },
    ]
    const created = await call(fx.app, {
      method: 'POST',
      url: '/sources',
      as: fx.admin,
      payload: {
        name: `Источник ${run}`,
        spaceId: fx.spaceId,
        integrationId,
        query: { kind: 'table', schema, table },
        mode: 'snapshot',
        columns,
        keyFields: ['id'],
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    sourceId = created.json().id
    datasetId = created.json().datasetId
    expect(datasetId).toBeTruthy()
  })

  it('синхронизация снимком переносит строки и даёт версию', async () => {
    const started = await call(fx.app, {
      method: 'POST',
      url: `/sources/${sourceId}/sync`,
      as: fx.admin,
    })
    expect(started.statusCode, started.body).toBe(200)
    const result = await runJob(started.json().jobId)
    expect(result.rows).toBe(2)
    expect(result.inserted).toBe(2)

    const versions = await call(fx.app, {
      method: 'GET',
      url: `/datasets/${datasetId}/versions`,
      as: fx.admin,
    })
    expect(versions.statusCode, versions.body).toBe(200)
    expect(versions.json().items[0].origin).toBe('sync')

    const runs = await call(fx.app, {
      method: 'GET',
      url: `/sources/${sourceId}/runs`,
      as: fx.admin,
    })
    expect(runs.json().items[0].status).toBe('succeeded')
  })

  it('повторный снимок не задваивает строки', async () => {
    const started = await call(fx.app, {
      method: 'POST',
      url: `/sources/${sourceId}/sync`,
      as: fx.admin,
    })
    const result = await runJob(started.json().jobId)
    expect(result.rows).toBe(2)

    const dataset = await call(fx.app, {
      method: 'GET',
      url: `/datasets/${datasetId}`,
      as: fx.admin,
    })
    expect(dataset.json().rowCount).toBe(2)
  })

  it('инкремент без поля-курсора не заводится', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/sources',
      as: fx.admin,
      payload: {
        name: `Инкремент без курсора ${run}`,
        spaceId: fx.spaceId,
        integrationId,
        query: { kind: 'table', schema, table },
        mode: 'incremental',
        columns: [{ name: 'id', nativeType: '23', type: 'integer', key: 'id' }],
        keyFields: ['id'],
      },
    })
    expect(created.statusCode).toBe(400)
  })

  it('инкремент добирает строки по курсору', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/sources',
      as: fx.admin,
      payload: {
        name: `Инкремент ${run}`,
        spaceId: fx.spaceId,
        integrationId,
        query: { kind: 'table', schema, table },
        mode: 'incremental',
        cursorField: 'updated_at',
        columns: [
          { name: 'id', nativeType: '23', type: 'integer', key: 'id' },
          { name: 'name', nativeType: '25', type: 'text', key: 'name' },
          { name: 'updated_at', nativeType: '1184', type: 'datetime', key: 'updated_at' },
        ],
        keyFields: ['id'],
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const incrementalId = created.json().id

    const first = await call(fx.app, {
      method: 'POST',
      url: `/sources/${incrementalId}/sync`,
      as: fx.admin,
    })
    expect((await runJob(first.json().jobId)).rows).toBe(2)

    await db().execute(
      sql.raw(
        `INSERT INTO ${schema}.${table} (id, name, updated_at) VALUES (3, 'третья', '2026-03-01T00:00:00Z')`,
      ),
    )
    const second = await call(fx.app, {
      method: 'POST',
      url: `/sources/${incrementalId}/sync`,
      as: fx.admin,
    })
    const result = await runJob(second.json().jobId)
    // Второй прогон берёт только новую строку — курсор запомнен
    expect(result.rows).toBe(1)
    expect(result.inserted).toBe(1)
  })
})
