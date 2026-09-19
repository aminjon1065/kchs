import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
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
 * Предпросмотр изменений при обновлении датасета (P2-E03 S04, ADR-0068):
 * upsert/sync с `review` после разбора файла сравнивается с датасетом по
 * ключу и ждёт публикации или отмены. Тест играет роль движка и воркера:
 * кладёт нормализованный CSV, сообщает итог и выполняет задания напрямую.
 */
registerLifecycle()

const token = process.env.INTERNAL_SERVICE_TOKEN ?? ''
const { ImportService } = await import('../src/modules/data/domain/import-service.js')
const { s3, buckets } = await import('../src/kernel/storage/s3.js')

let fx: TestContext
const run = Date.now().toString(36)
const noProgress = async () => undefined

beforeAll(async () => {
  fx = await setupFixture()
})

const MAPPING = [
  { column: 0, fieldKey: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
  { column: 1, fieldKey: 'region', label: { ru: 'Регион' }, type: 'text', semantic: 'category' },
  { column: 2, fieldKey: 'capacity', label: { ru: 'Мест' }, type: 'integer', semantic: 'measure' },
]

async function startImport(payload: Record<string, unknown>, as: TestUser = fx.admin) {
  const file = await uploadFile(fx.app, fx.admin, {
    spaceId: fx.spaceId,
    name: `pvr-${run}.csv`,
    content: 'code;region;capacity\n',
    mime: 'text/csv',
  })
  return call(fx.app, {
    method: 'POST',
    url: '/datasets/imports',
    as,
    payload: { fileId: file.id, mapping: MAPPING, key: ['code'], ...payload },
  })
}

/** Движок: нормализованный CSV в хранилище и отчёт; ответ — задание загрузки или сравнения. */
async function normalized(importId: string, lines: string[]) {
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
      rows: lines.length,
      errors: 0,
      normalizedKey: key,
      errorsKey: null,
      errorSample: [],
    },
    headers: { 'x-kchs-service-token': token },
  })
  expect(report.statusCode, report.body).toBe(200)
  return { key, jobId: report.json().loadJobId as string }
}

async function state(importId: string, as: TestUser = fx.admin) {
  const response = await call(fx.app, { url: `/datasets/imports/${importId}`, as })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

async function rowsOf(datasetId: string) {
  const [meta] = await db().execute<{ physical_table: string }>(
    sql`SELECT physical_table FROM datasets WHERE id = ${datasetId}`,
  )
  const fields = await db().execute<{ key: string; physical_column: string }>(
    sql`SELECT key, physical_column FROM dataset_fields WHERE dataset_id = ${datasetId}`,
  )
  const col = Object.fromEntries(fields.map((field) => [field.key, field.physical_column]))
  return db().execute<{ code: string; capacity: number; deleted: boolean }>(
    sql.raw(`SELECT ${col.code} AS code, ${col.capacity}::int AS capacity,
                    _deleted_at IS NOT NULL AS deleted
               FROM ds."${meta?.physical_table}" ORDER BY ${col.code}`),
  )
}

async function eventsOf(importId: string) {
  const events = await db().execute<{ type: string }>(
    sql`SELECT type FROM ops.outbox WHERE event->'payload'->>'importId' = ${importId} ORDER BY id`,
  )
  return events.map((event) => event.type)
}

/** Датасет с ключом и тремя строками — загружен обычным импортом. */
async function dataset(name: string): Promise<string> {
  const created = await startImport({
    target: { kind: 'new', name: `${name} ${run}`, spaceId: fx.spaceId },
  })
  expect(created.statusCode, created.body).toBe(200)
  const importId = created.json().id as string
  await normalized(importId, ['2,P-1,Хатлон,100', '3,P-2,Согд,50', '4,P-3,ГБАО,20'])
  await ImportService.load({ importId }, noProgress)
  return created.json().datasetId as string
}

describe('предпросмотр изменений: upsert', () => {
  it('сравнение по ключу, примеры «было → стало», публикация загружает как обычно', async () => {
    const datasetId = await dataset('ПВР')
    const started = await startImport({
      target: { kind: 'existing', datasetId, mode: 'upsert' },
      review: true,
    })
    expect(started.statusCode, started.body).toBe(200)
    expect(started.json()).toMatchObject({ status: 'normalizing', review: true, diff: null })
    const importId = started.json().id as string

    const { jobId } = await normalized(importId, [
      '2,P-1,Хатлон,100',
      '3,P-2,Согд,75',
      '4,P-4,Душанбе,30',
      '5,P-4,Душанбе,35',
    ])
    const [job] = await db().execute<{ queue: string; name: string }>(
      sql`SELECT queue, name FROM jobs WHERE id = ${jobId}`,
    )
    expect(job).toMatchObject({ queue: 'data', name: 'dataset.compare' })
    expect((await state(importId)).status).toBe('comparing')
    // Загрузка до публикации не выполняется
    expect(await ImportService.load({ importId }, noProgress)).toEqual({ skipped: true })

    await ImportService.compare({ importId }, noProgress)
    const review = await state(importId)
    expect(review.status).toBe('review')
    expect(review.diff).toMatchObject({
      baseVersion: 2,
      added: 1,
      changed: 1,
      unchanged: 1,
      deleted: 0,
      duplicates: 1,
    })
    expect(review.diff.samples.changed).toEqual([
      {
        key: ['P-2'],
        row: 3,
        changes: [{ field: 'capacity', before: '50', after: '75' }],
      },
    ])
    expect(review.diff.samples.added).toEqual([
      {
        key: ['P-4'],
        row: 5,
        // Ключ — в `key`, в полях — остальные значения
        changes: [
          { field: 'region', before: null, after: 'Душанбе' },
          { field: 'capacity', before: null, after: '35' },
        ],
      },
    ])
    // Датасет ещё не изменён
    expect((await rowsOf(datasetId)).map((row) => [row.code, row.capacity])).toEqual([
      ['P-1', 100],
      ['P-2', 50],
      ['P-3', 20],
    ])

    // Читатель видит сводку, но не примеры: загружать в датасет он не вправе
    const byViewer = await state(importId, fx.users.viewer)
    expect(byViewer.diff).toMatchObject({ added: 1, changed: 1 })
    expect(byViewer.diff.samples).toEqual({ added: [], changed: [], deleted: [] })
    const viewerPublish = await call(fx.app, {
      method: 'POST',
      url: `/datasets/imports/${importId}/publish`,
      as: fx.users.viewer,
    })
    expect([403, 404]).toContain(viewerPublish.statusCode)
    // Редактор с политиками столбцов: скрытого поля нет, маскируемый ключ — без значений
    for (const payload of [
      { principal: { type: 'user', id: fx.users.member.id }, mode: 'hide', fields: ['region'] },
      { principal: { type: 'user', id: fx.users.member.id }, mode: 'mask', fields: ['code'] },
    ]) {
      const policy = await call(fx.app, {
        method: 'POST',
        url: `/datasets/${datasetId}/policies/columns`,
        as: fx.admin,
        payload,
      })
      expect(policy.statusCode, policy.body).toBe(200)
    }
    const byEditor = await state(importId, fx.users.member)
    expect(byEditor.diff.samples.changed).toEqual([
      { key: [null], row: 3, changes: [{ field: 'capacity', before: '50', after: '75' }] },
    ])
    expect(byEditor.diff.samples.added).toEqual([
      { key: [null], row: 5, changes: [{ field: 'capacity', before: null, after: '35' }] },
    ])
    // В списке импортов — без примеров
    const list = await call(fx.app, { url: `/datasets/${datasetId}/imports`, as: fx.admin })
    const listed = list.json().items.find((item: { id: string }) => item.id === importId)
    expect(listed.diff.samples.changed).toEqual([])

    const published = await call(fx.app, {
      method: 'POST',
      url: `/datasets/imports/${importId}/publish`,
      as: fx.admin,
    })
    expect(published.statusCode, published.body).toBe(200)
    expect(published.json().status).toBe('loading')
    const again = await call(fx.app, {
      method: 'POST',
      url: `/datasets/imports/${importId}/publish`,
      as: fx.admin,
    })
    expect(again.statusCode).toBe(409)

    await ImportService.load({ importId }, noProgress)
    const done = await state(importId)
    expect(done).toMatchObject({
      status: 'succeeded',
      version: 3,
      stats: { inserted: 1, updated: 1, errors: 1 },
    })
    expect((await rowsOf(datasetId)).map((row) => [row.code, row.capacity])).toEqual([
      ['P-1', 100],
      ['P-2', 75],
      ['P-3', 20],
      ['P-4', 35],
    ])
    expect(await eventsOf(importId)).toEqual([
      'dataset.import_started',
      'dataset.import_review',
      'dataset.import_published',
      'dataset.imported',
    ])
  })
})

describe('предпросмотр изменений: sync и отмена', () => {
  it('удаляемые и восстанавливаемые строки; отмена не меняет датасет и удаляет файл', async () => {
    const datasetId = await dataset('Синхронизация')
    // P-3 удалена прежней синхронизацией
    const first = await startImport({ target: { kind: 'existing', datasetId, mode: 'sync' } })
    await normalized(first.json().id, ['2,P-1,Хатлон,100', '3,P-2,Согд,50'])
    await ImportService.load({ importId: first.json().id }, noProgress)

    const started = await startImport({
      target: { kind: 'existing', datasetId, mode: 'sync' },
      review: true,
    })
    const importId = started.json().id as string
    const { key } = await normalized(importId, ['2,P-2,Согд,50', '3,P-3,ГБАО,20', '4,P-5,Нурек,10'])
    await ImportService.compare({ importId }, noProgress)
    const review = await state(importId)
    expect(review.diff).toMatchObject({ added: 1, changed: 1, unchanged: 1, deleted: 1 })
    expect(review.diff.samples.changed).toEqual([
      { key: ['P-3'], row: 3, changes: [], restored: true },
    ])
    expect(review.diff.samples.deleted).toEqual([
      {
        key: ['P-1'],
        row: null,
        changes: [
          { field: 'region', before: 'Хатлон', after: null },
          { field: 'capacity', before: '100', after: null },
        ],
      },
    ])

    const cancelled = await call(fx.app, {
      method: 'POST',
      url: `/datasets/imports/${importId}/cancel`,
      as: fx.admin,
    })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    expect(cancelled.json()).toMatchObject({ status: 'cancelled' })
    expect(cancelled.json().finishedAt).not.toBeNull()
    await expect(
      s3().send(new HeadObjectCommand({ Bucket: buckets.files(), Key: key })),
    ).rejects.toThrow()
    for (const action of ['cancel', 'publish']) {
      const repeated = await call(fx.app, {
        method: 'POST',
        url: `/datasets/imports/${importId}/${action}`,
        as: fx.admin,
      })
      expect(repeated.statusCode).toBe(409)
    }
    // Запоздалое задание загрузки отменённый импорт не трогает
    expect(await ImportService.load({ importId }, noProgress)).toEqual({ skipped: true })
    expect((await rowsOf(datasetId)).map((row) => [row.code, row.deleted])).toEqual([
      ['P-1', false],
      ['P-2', false],
      ['P-3', true],
    ])
    const record = await call(fx.app, { url: `/datasets/${datasetId}`, as: fx.admin })
    expect(record.json().currentVersion).toBe(3)
    expect(await eventsOf(importId)).toEqual([
      'dataset.import_started',
      'dataset.import_review',
      'dataset.import_cancelled',
    ])
  })

  it('предпросмотр — только для обновления по ключу существующего датасета', async () => {
    const datasetId = await dataset('Проверки')
    const append = await startImport({
      target: { kind: 'existing', datasetId, mode: 'append' },
      review: true,
    })
    expect(append.statusCode).toBe(400)
    const created = await startImport({
      target: { kind: 'new', name: `Новый ${run}`, spaceId: fx.spaceId },
      review: true,
    })
    expect(created.statusCode).toBe(400)
  })
})
