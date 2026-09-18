import { PutObjectCommand } from '@aws-sdk/client-s3'
import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
  uploadFile,
} from './helpers.js'

/**
 * Датасеты и импорт (P1-E01, P1-E02 S03; ADR-0046). Тест играет роль движка:
 * кладёт нормализованный CSV в хранилище и сообщает итог внутренним маршрутом,
 * загрузку воркером вызывает напрямую.
 */
registerLifecycle()

const token = process.env.INTERNAL_SERVICE_TOKEN ?? ''
const { ImportService } = await import('../src/modules/data/domain/import-service.js')
const { s3, buckets } = await import('../src/kernel/storage/s3.js')

let fx: TestContext
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
})

const MAPPING = [
  { column: 0, fieldKey: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
  { column: 1, fieldKey: 'region', label: { ru: 'Регион' }, type: 'text', semantic: 'category' },
  { column: 2, fieldKey: 'amount', label: { ru: 'Сумма' }, type: 'number', semantic: 'measure' },
  { column: 3, fieldKey: 'day', label: { ru: 'Дата' }, type: 'date', semantic: 'time' },
]

async function sourceFile(name = `svodka-${run}.csv`) {
  return uploadFile(fx.app, fx.admin, {
    spaceId: fx.spaceId,
    name,
    content: 'code;region;amount;day\n',
    mime: 'text/csv',
  })
}

/** Движок: нормализованный CSV в хранилище и отчёт; затем загрузка воркером. */
async function normalizeAndLoad(
  importId: string,
  lines: string[],
  extra: { errors?: number; errorSample?: unknown[] } = {},
) {
  const [job] = await db().execute<{ payload: { output: { normalizedKey: string } } }>(
    sql`SELECT j.payload FROM jobs j JOIN imports i ON i.job_id = j.id WHERE i.id = ${importId}`,
  )
  const key = job?.payload.output.normalizedKey as string
  await s3().send(
    new PutObjectCommand({
      Bucket: buckets.files(),
      Key: key,
      Body: `${lines.join('\n')}\n`,
      ContentType: 'text/csv',
    }),
  )
  const report = await call(fx.app, {
    method: 'POST',
    url: `/internal/data/imports/${importId}/normalized`,
    payload: {
      jobRecordId: 'engine-job',
      rows: lines.length + (extra.errors ?? 0),
      errors: extra.errors ?? 0,
      normalizedKey: key,
      errorsKey: extra.errors ? `imports/${importId}/errors.csv` : null,
      errorSample: extra.errorSample ?? [],
    },
    headers: { 'x-kchs-service-token': token },
  })
  expect(report.statusCode, report.body).toBe(200)
  if (report.json().loadJobId) {
    await ImportService.load({ importId }, async () => undefined)
  }
  const state = await call(fx.app, { url: `/datasets/imports/${importId}`, as: fx.admin })
  return state.json()
}

async function startImport(payload: Record<string, unknown>, as: TestUser = fx.admin) {
  const file = await sourceFile()
  return call(fx.app, {
    method: 'POST',
    url: '/datasets/imports',
    as,
    payload: { fileId: file.id, mapping: MAPPING, ...payload },
  })
}

async function rowsOf(datasetId: string) {
  const [meta] = await db().execute<{ physical_table: string }>(
    sql`SELECT physical_table FROM datasets WHERE id = ${datasetId}`,
  )
  const table = meta?.physical_table as string
  const fields = await db().execute<{ key: string; physical_column: string }>(
    sql`SELECT key, physical_column FROM dataset_fields WHERE dataset_id = ${datasetId}`,
  )
  const col = Object.fromEntries(fields.map((field) => [field.key, field.physical_column]))
  return db().execute<{ code: string; amount: number; _ver: number; deleted: boolean }>(
    sql.raw(`SELECT ${col.code} AS code, ${col.amount} AS amount, _ver, _deleted_at IS NOT NULL AS deleted
               FROM ds."${table}" ORDER BY ${col.code}`),
  )
}

describe('датасет: создание и хранение', () => {
  it('датасет — объект реестра с таблицей в ds; kchs_query читает строки, но не историю', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/datasets',
      as: fx.admin,
      payload: {
        name: `Происшествия ${run}`,
        spaceId: fx.spaceId,
        fields: [
          { key: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
          { key: 'damage', label: { ru: 'Ущерб' }, type: 'money', semantic: 'measure' },
          { key: 'occurred', label: { ru: 'Дата' }, type: 'datetime', semantic: 'time' },
        ],
        primaryKey: ['code'],
        timeField: 'occurred',
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const id = created.json().id as string

    const record = await call(fx.app, { url: `/datasets/${id}`, as: fx.admin })
    expect(record.statusCode).toBe(200)
    expect(record.json()).toMatchObject({
      kind: 'table',
      currentVersion: 1,
      rowCount: 0,
      primaryKey: ['code'],
      timeField: 'occurred',
      settings: { editable: true, trackHistory: true },
    })
    expect(record.json().fields.map((field: { key: string }) => field.key)).toEqual([
      'code',
      'damage',
      'occurred',
    ])
    // Физическое имя наружу не отдаётся
    expect(JSON.stringify(record.json())).not.toContain('c_1')

    const hex = id.replaceAll('-', '')
    const grants = await db().execute<{ table_name: string; privilege_type: string }>(
      sql`SELECT table_name, privilege_type FROM information_schema.role_table_grants
           WHERE grantee = 'kchs_query' AND table_schema = 'ds' AND table_name LIKE ${`%${hex}`}`,
    )
    expect(grants.map((g) => `${g.table_name}:${g.privilege_type}`)).toEqual([`t_${hex}:SELECT`])
    const history = await db().execute(
      sql`SELECT 1 FROM information_schema.tables WHERE table_schema = 'ds' AND table_name = ${`h_${hex}`}`,
    )
    expect(history).toHaveLength(1)

    const outbox = await db().execute<{ type: string }>(
      sql`SELECT type FROM ops.outbox WHERE type = 'dataset.created' AND event->'object'->>'id' = ${id}`,
    )
    expect(outbox).toHaveLength(1)
  })

  it('создавать в чужом пространстве нельзя; ключ должен быть среди полей', async () => {
    const foreign = await call(fx.app, {
      method: 'POST',
      url: '/datasets',
      as: fx.users.stranger,
      payload: {
        name: 'Чужой',
        spaceId: fx.spaceId,
        fields: [{ key: 'a', label: { ru: 'А' }, type: 'text' }],
      },
    })
    expect([403, 404]).toContain(foreign.statusCode)

    const badKey = await call(fx.app, {
      method: 'POST',
      url: '/datasets',
      as: fx.admin,
      payload: {
        name: 'Без ключа',
        spaceId: fx.spaceId,
        fields: [{ key: 'a', label: { ru: 'А' }, type: 'text' }],
        primaryKey: ['missing'],
      },
    })
    expect(badKey.statusCode).toBe(400)
  })
})

describe('импорт: режимы загрузки', () => {
  it('новый датасет: нормализованный файл загружается, версия 2, событие dataset.imported', async () => {
    const started = await startImport({
      target: { kind: 'new', name: `Сводка ${run}`, spaceId: fx.spaceId },
      key: ['code'],
    })
    expect(started.statusCode, started.body).toBe(200)
    expect(started.json().status).toBe('normalizing')
    const importId = started.json().id as string
    const datasetId = started.json().datasetId as string

    // Задание движку поставлено в той же транзакции
    const [job] = await db().execute<{ queue: string; name: string }>(
      sql`SELECT j.queue, j.name FROM jobs j JOIN imports i ON i.job_id = j.id WHERE i.id = ${importId}`,
    )
    expect(job).toMatchObject({ queue: 'imports', name: 'dataset.normalize' })

    const done = await normalizeAndLoad(importId, [
      '2,A-1,Хатлон,12.5,2026-05-01',
      '3,A-2,Согд,7,2026-05-02',
      '4,A-3,"ГБАО, Хорог",,2026-05-03',
    ])
    expect(done).toMatchObject({
      status: 'succeeded',
      version: 2,
      stats: { rows: 3, inserted: 3, errors: 0 },
    })
    const dataset = await call(fx.app, { url: `/datasets/${datasetId}`, as: fx.admin })
    expect(dataset.json()).toMatchObject({ rowCount: 3, currentVersion: 2 })
    expect((await rowsOf(datasetId)).map((row) => [row.code, row.amount])).toEqual([
      ['A-1', 12.5],
      ['A-2', 7],
      ['A-3', null],
    ])
    const versions = await call(fx.app, { url: `/datasets/${datasetId}/versions`, as: fx.admin })
    expect(versions.json().items[0]).toMatchObject({
      number: 2,
      origin: 'import',
      rowCount: 3,
      importId,
    })
    const events = await db().execute<{ type: string }>(
      sql`SELECT type FROM ops.outbox WHERE event->'object'->>'id' = ${datasetId}
           AND type LIKE 'dataset.%' ORDER BY id`,
    )
    expect(events.map((row) => row.type)).toEqual([
      'dataset.created',
      'dataset.import_started',
      'dataset.imported',
    ])
  })

  it('upsert: изменённые строки обновляются с ростом _ver, новые добавляются, повтор ключа — в ошибки', async () => {
    const first = await startImport({
      target: { kind: 'new', name: `Upsert ${run}`, spaceId: fx.spaceId },
      key: ['code'],
    })
    const datasetId = first.json().datasetId as string
    await normalizeAndLoad(first.json().id, [
      '2,U-1,Хатлон,1,2026-01-01',
      '3,U-2,Согд,2,2026-01-02',
    ])

    const second = await startImport({
      target: { kind: 'existing', datasetId, mode: 'upsert' },
      key: ['code'],
    })
    expect(second.statusCode, second.body).toBe(200)
    const done = await normalizeAndLoad(second.json().id, [
      '2,U-1,Хатлон,1,2026-01-01',
      '3,U-2,Согд,20,2026-01-02',
      '4,U-3,ГБАО,3,2026-01-03',
      '5,U-3,ГБАО,30,2026-01-03',
    ])
    expect(done).toMatchObject({
      status: 'succeeded',
      stats: { inserted: 1, updated: 1, errors: 1 },
    })
    expect(done.errorSample).toEqual([expect.objectContaining({ row: 4, reason: 'duplicate_key' })])
    const rows = await rowsOf(datasetId)
    // Неизменённая строка не трогается; из повторов остаётся последняя строка файла
    expect(rows.map((row) => [row.code, row.amount, row._ver])).toEqual([
      ['U-1', 1, 1],
      ['U-2', 20, 2],
      ['U-3', 30, 1],
    ])
  })

  it('sync: строки, которых нет в файле, помечаются удалёнными; replace — полная замена с правами', async () => {
    const first = await startImport({
      target: { kind: 'new', name: `Sync ${run}`, spaceId: fx.spaceId },
      key: ['code'],
    })
    const datasetId = first.json().datasetId as string
    await normalizeAndLoad(first.json().id, ['2,S-1,А,1,2026-01-01', '3,S-2,Б,2,2026-01-02'])

    const sync = await startImport({
      target: { kind: 'existing', datasetId, mode: 'sync' },
      key: ['code'],
    })
    const synced = await normalizeAndLoad(sync.json().id, ['2,S-2,Б,2,2026-01-02'])
    expect(synced.stats).toMatchObject({ inserted: 0, updated: 0, deleted: 1 })
    expect((await rowsOf(datasetId)).map((row) => [row.code, row.deleted])).toEqual([
      ['S-1', true],
      ['S-2', false],
    ])

    const replace = await startImport({ target: { kind: 'existing', datasetId, mode: 'replace' } })
    const replaced = await normalizeAndLoad(replace.json().id, [
      '2,R-1,В,5,2026-02-01',
      '3,R-2,Г,6,2026-02-02',
      '4,R-3,Д,7,2026-02-03',
    ])
    expect(replaced).toMatchObject({ status: 'succeeded', stats: { inserted: 3, deleted: 1 } })
    expect((await rowsOf(datasetId)).map((row) => row.code)).toEqual(['R-1', 'R-2', 'R-3'])
    const hex = datasetId.replaceAll('-', '')
    const grants = await db().execute(
      sql`SELECT 1 FROM information_schema.role_table_grants
           WHERE grantee = 'kchs_query' AND table_schema = 'ds' AND table_name = ${`t_${hex}`}`,
    )
    expect(grants).toHaveLength(1)
  })

  it('«остановить при ошибках»: импорт не загружается, событие import_failed', async () => {
    const started = await startImport({
      target: { kind: 'new', name: `Стоп ${run}`, spaceId: fx.spaceId },
      onError: 'stop',
    })
    const importId = started.json().id as string
    const done = await normalizeAndLoad(importId, ['2,X-1,А,1,2026-01-01'], {
      errors: 2,
      errorSample: [{ row: 3, column: 'amount', value: 'двенадцать', reason: 'invalid_number' }],
    })
    expect(done).toMatchObject({ status: 'failed', stats: { errors: 2, inserted: 0 } })
    const events = await db().execute<{ type: string }>(
      sql`SELECT type FROM ops.outbox WHERE type = 'dataset.import_failed'
           AND event->'payload'->>'importId' = ${importId}`,
    )
    expect(events).toHaveLength(1)
  })
})

describe('импорт: права и внутренний маршрут', () => {
  it('отчёт движка без сервисного токена отклоняется', async () => {
    const started = await startImport({
      target: { kind: 'new', name: `Токен ${run}`, spaceId: fx.spaceId },
    })
    const response = await call(fx.app, {
      method: 'POST',
      url: `/internal/data/imports/${started.json().id}/normalized`,
      payload: {
        jobRecordId: 'x',
        rows: 0,
        errors: 0,
        normalizedKey: 'imports/x/normalized.csv',
        errorsKey: null,
        errorSample: [],
      },
      headers: { 'x-kchs-service-token': 'не тот' },
    })
    expect(response.statusCode).toBe(401)
  })

  it('загрузить в датасет без права правки нельзя; сопоставление с несуществующим полем — 400', async () => {
    const started = await startImport({
      target: { kind: 'new', name: `Права ${run}`, spaceId: fx.spaceId },
    })
    const datasetId = started.json().datasetId as string

    // Читатель пространства видит файл и датасет, но загружать в датасет не вправе
    const byViewer = await startImport(
      { target: { kind: 'existing', datasetId, mode: 'append' } },
      fx.users.viewer,
    )
    expect(byViewer.statusCode, byViewer.body).toBe(403)
    const byMember = await startImport(
      { target: { kind: 'existing', datasetId, mode: 'append' } },
      fx.users.member,
    )
    expect(byMember.statusCode, byMember.body).toBe(200)

    const wrongField = await startImport({
      target: { kind: 'existing', datasetId, mode: 'append' },
      mapping: [{ ...MAPPING[0], fieldKey: 'nope' }],
    })
    expect(wrongField.statusCode).toBe(400)
  })
})
