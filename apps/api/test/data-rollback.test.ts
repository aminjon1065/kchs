import { PutObjectCommand } from '@aws-sdk/client-s3'
import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  uploadFile,
} from './helpers.js'

/**
 * Откат датасета к прежней версии (P1-E01 S04, ADR-0062): отмена правок строк
 * и импорта «дополнить» новой версией `rollback`; версии без прежних значений
 * (замена, синхронизация, смена схемы, правки без истории) откат блокируют.
 */
registerLifecycle()

const token = process.env.INTERNAL_SERVICE_TOKEN ?? ''
const { ImportService } = await import('../src/modules/data/domain/import-service.js')
const { Physical, historyName } = await import('../src/modules/data/infra/physical.js')
const { s3, buckets } = await import('../src/kernel/storage/s3.js')

let fx: TestContext
const run = Date.now().toString(36)

async function createDataset(name: string): Promise<string> {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `${name} ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier', required: true },
        { key: 'region', label: { ru: 'Регион' }, type: 'text' },
        { key: 'amount', label: { ru: 'Сумма' }, type: 'number' },
      ],
      primaryKey: ['code'],
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  return created.json().id as string
}

async function insert(datasetId: string, rows: Array<Record<string, unknown>>) {
  const inserted = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows`,
    as: fx.admin,
    payload: { rows: rows.map((values) => ({ values })) },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)
  return inserted.json().items as Array<{ _id: string; _ver: number }>
}

async function patch(datasetId: string, rowId: string, values: Record<string, unknown>) {
  const current = await call(fx.app, { url: `/datasets/${datasetId}/rows/${rowId}`, as: fx.admin })
  const patched = await call(fx.app, {
    method: 'PATCH',
    url: `/datasets/${datasetId}/rows/${rowId}`,
    as: fx.admin,
    payload: { values, ver: current.json()._ver },
  })
  expect(patched.statusCode, patched.body).toBe(200)
}

async function remove(datasetId: string, ids: string[]) {
  const removed = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows/delete`,
    as: fx.admin,
    payload: { ids },
  })
  expect(removed.statusCode, removed.body).toBe(200)
}

const rollback = (datasetId: string, target: number, as = fx.admin) =>
  call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/versions/${target}/rollback`,
    as,
  })

const datasetOf = async (datasetId: string) =>
  (await call(fx.app, { url: `/datasets/${datasetId}`, as: fx.admin })).json()

/** Физические строки, включая мягко удалённые: код → значения и признак удаления. */
async function state(datasetId: string) {
  const [meta] = await db().execute<{ physical_table: string }>(
    sql`SELECT physical_table FROM datasets WHERE id = ${datasetId}`,
  )
  const fields = await db().execute<{ key: string; physical_column: string }>(
    sql`SELECT key, physical_column FROM dataset_fields WHERE dataset_id = ${datasetId}`,
  )
  const col = Object.fromEntries(fields.map((field) => [field.key, field.physical_column]))
  const rows = await db().execute<{
    code: string
    region: string | null
    amount: number | null
    deleted: boolean
  }>(
    sql.raw(`SELECT ${col.code} AS code, ${col.region} AS region, ${col.amount} AS amount,
                    _deleted_at IS NOT NULL AS deleted
               FROM ds."${meta?.physical_table}" ORDER BY ${col.code}`),
  )
  return Object.fromEntries(
    rows.map((row) => [
      row.code,
      {
        region: row.region,
        amount: row.amount === null ? null : Number(row.amount),
        deleted: row.deleted,
      },
    ]),
  )
}

beforeAll(async () => {
  fx = await setupFixture()
})

describe('откат: правки строк', () => {
  it('правки, вставки и удаления отменяются новой версией; откат отката возвращает правки', async () => {
    const datasetId = await createDataset('Откат правок')
    const [a, b, c] = await insert(datasetId, [
      { code: 'A', region: 'Хатлон', amount: 10 },
      { code: 'B', region: 'Согд', amount: 20 },
      { code: 'C', region: 'ГБАО', amount: 30 },
    ]) // версия 2
    await patch(datasetId, String(a?._id), { amount: 15 }) // 3
    await remove(datasetId, [String(b?._id)]) // 4
    await insert(datasetId, [{ code: 'D', region: 'Душанбе', amount: 40 }]) // 5
    await patch(datasetId, String(c?._id), { region: 'РРП', amount: 35 }) // 6
    await patch(datasetId, String(c?._id), { amount: 36 }) // 7

    const done = await rollback(datasetId, 2)
    expect(done.statusCode, done.body).toBe(200)
    expect(done.json()).toMatchObject({
      number: 8,
      origin: 'rollback',
      rowCount: 3,
      diff: { added: 1, updated: 3, deleted: 1 },
    })
    expect(await state(datasetId)).toEqual({
      A: { region: 'Хатлон', amount: 10, deleted: false },
      B: { region: 'Согд', amount: 20, deleted: false },
      C: { region: 'ГБАО', amount: 30, deleted: false },
      D: { region: 'Душанбе', amount: 40, deleted: true },
    })
    expect(await datasetOf(datasetId)).toMatchObject({ currentVersion: 8, rowCount: 3 })

    // Отмена пишется в историю строки: прежнее значение — текущее до отката
    const history = await call(fx.app, {
      url: `/datasets/${datasetId}/rows/${a?._id}/history`,
      as: fx.admin,
    })
    expect(history.json().items[0]).toMatchObject({
      op: 'update',
      values: { amount: 10 },
      previous: { amount: 15 },
    })
    const events = await db().execute<{ payload: unknown }>(
      sql`SELECT event->'payload' AS payload FROM ops.outbox
           WHERE type = 'dataset.rolled_back' AND event->'object'->>'id' = ${datasetId}`,
    )
    expect(events.map((row) => row.payload)).toEqual([{ version: 8, target: 2, from: 7 }])

    // Откат — тоже версия: отмена отката возвращает состояние версии 7
    const undo = await rollback(datasetId, 7)
    expect(undo.statusCode, undo.body).toBe(200)
    expect(undo.json()).toMatchObject({ number: 9, origin: 'rollback', rowCount: 3 })
    expect(await state(datasetId)).toEqual({
      A: { region: 'Хатлон', amount: 15, deleted: false },
      B: { region: 'Согд', amount: 20, deleted: true },
      C: { region: 'РРП', amount: 36, deleted: false },
      D: { region: 'Душанбе', amount: 40, deleted: false },
    })

    // Строки с версией после отката по-прежнему правятся с проверкой `_ver`
    await patch(datasetId, String(a?._id), { amount: 16 })
    expect((await state(datasetId)).A).toMatchObject({ amount: 16 })
  })

  it('границы, права, выключенная история и правки без истории', async () => {
    const datasetId = await createDataset('Откат границы')
    const [row] = await insert(datasetId, [{ code: 'A', amount: 1 }]) // 2

    expect((await rollback(datasetId, 2)).statusCode).toBe(400)
    expect((await rollback(datasetId, 5)).statusCode).toBe(400)
    expect((await rollback(datasetId, 0)).statusCode).toBe(400)
    expect((await rollback(datasetId, 1, fx.users.member)).statusCode).toBe(403)

    const toggle = (trackHistory: boolean) =>
      call(fx.app, {
        method: 'PATCH',
        url: `/datasets/${datasetId}`,
        as: fx.admin,
        payload: { settings: { trackHistory } },
      })
    expect((await toggle(false)).statusCode).toBe(200)
    const off = await rollback(datasetId, 1)
    expect(off.statusCode).toBe(409)
    expect(off.json().detail).toContain('История строк датасета выключена')

    // Правка без истории (версия 3) не отменяется и после включения истории
    await patch(datasetId, String(row?._id), { amount: 2 })
    expect((await toggle(true)).statusCode).toBe(200)
    await patch(datasetId, String(row?._id), { amount: 3 }) // 4
    const blocked = await rollback(datasetId, 2)
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().detail).toContain('версия 3 — история строк этой версии не сохранена')
    expect((await state(datasetId)).A).toMatchObject({ amount: 3 })

    // До правки без истории откатить можно
    const partial = await rollback(datasetId, 3)
    expect(partial.statusCode, partial.body).toBe(200)
    expect((await state(datasetId)).A).toMatchObject({ amount: 2 })
  })

  it('прежнее значение ключа занято другой строкой — 409, данные не тронуты', async () => {
    const datasetId = await createDataset('Откат ключ')
    const [row] = await insert(datasetId, [{ code: 'K-1', amount: 1 }]) // 2
    await patch(datasetId, String(row?._id), { code: 'K-2' }) // 3
    await insert(datasetId, [{ code: 'K-1', amount: 5 }]) // 4

    const conflict = await rollback(datasetId, 2)
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().detail).toContain('прежнее значение ключа занято')
    expect(await state(datasetId)).toEqual({
      'K-1': { region: null, amount: 5, deleted: false },
      'K-2': { region: null, amount: 1, deleted: false },
    })
    expect(await datasetOf(datasetId)).toMatchObject({ currentVersion: 4, rowCount: 2 })
  })
})

describe('откат: импорт и схема', () => {
  const MAPPING = [
    {
      column: 0,
      fieldKey: 'code',
      label: { ru: 'Код' },
      type: 'identifier',
      semantic: 'identifier',
    },
    { column: 1, fieldKey: 'region', label: { ru: 'Регион' }, type: 'text', semantic: 'category' },
    { column: 2, fieldKey: 'amount', label: { ru: 'Сумма' }, type: 'number', semantic: 'measure' },
  ]

  /** Импорт с ролью движка: нормализованный CSV в хранилище, отчёт, загрузка воркером. */
  async function load(target: Record<string, unknown>, lines: string[]) {
    const file = await uploadFile(fx.app, fx.admin, {
      spaceId: fx.spaceId,
      name: `otkat-${run}.csv`,
      content: 'code;region;amount\n',
      mime: 'text/csv',
    })
    const started = await call(fx.app, {
      method: 'POST',
      url: '/datasets/imports',
      as: fx.admin,
      payload: { fileId: file.id, mapping: MAPPING, key: ['code'], target },
    })
    expect(started.statusCode, started.body).toBe(200)
    const importId = started.json().id as string
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
    await ImportService.load({ importId }, async () => undefined)
    const result = (
      await call(fx.app, { url: `/datasets/imports/${importId}`, as: fx.admin })
    ).json()
    expect(result.status, JSON.stringify(result)).toBe('succeeded')
    return started.json() as { id: string; datasetId: string }
  }

  it('импорт «дополнить» отменяется по его строкам; замена и смена схемы блокируют откат', async () => {
    const first = await load({ kind: 'new', name: `Откат импорта ${run}`, spaceId: fx.spaceId }, [
      '2,I-1,Хатлон,1',
      '3,I-2,Согд,2',
    ])
    const datasetId = first.datasetId
    const base = (await datasetOf(datasetId)).currentVersion as number

    await load({ kind: 'existing', datasetId, mode: 'append' }, ['2,I-3,ГБАО,3', '3,I-4,РРП,4'])
    const [appended] = (
      await call(fx.app, {
        method: 'POST',
        url: `/datasets/${datasetId}/rows/query`,
        as: fx.admin,
        payload: { where: { field: 'code', op: 'eq', value: 'I-3' } },
      })
    ).json().rows as unknown[][]
    const fields = (
      await call(fx.app, {
        method: 'POST',
        url: `/datasets/${datasetId}/rows/query`,
        as: fx.admin,
        payload: { limit: 1 },
      })
    ).json().fields as Array<{ name: string }>
    const idIndex = fields.findIndex((field) => field.name === '_id')
    // Дозагруженную строку ещё и правят: сначала отменяется правка, затем импорт
    await patch(datasetId, String(appended?.[idIndex]), { amount: 30 })

    const done = await rollback(datasetId, base)
    expect(done.statusCode, done.body).toBe(200)
    expect(done.json()).toMatchObject({
      origin: 'rollback',
      rowCount: 2,
      diff: { added: 0, updated: 1, deleted: 2 },
    })
    expect(await state(datasetId)).toMatchObject({
      'I-1': { deleted: false },
      'I-2': { deleted: false },
      'I-3': { amount: 3, deleted: true },
      'I-4': { deleted: true },
    })
    const afterRollback = (await datasetOf(datasetId)).currentVersion as number

    // Замена не хранит прежних строк: за неё откатить нельзя
    await load({ kind: 'existing', datasetId, mode: 'replace' }, ['2,R-1,Хатлон,9'])
    const blocked = await rollback(datasetId, afterRollback)
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().detail).toContain('импорт в режиме «заменить»')

    // Смена схемы — тоже граница отката
    const replaced = (await datasetOf(datasetId)).currentVersion as number
    const added = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/fields`,
      as: fx.admin,
      payload: { key: 'note', label: { ru: 'Заметка' }, type: 'text' },
    })
    expect(added.statusCode, added.body).toBe(200)
    const schema = await rollback(datasetId, replaced)
    expect(schema.statusCode).toBe(409)
    expect(schema.json().detail).toContain('менялась схема')
  })
})

describe('откат: таблицы истории прежних версий', () => {
  it('таблица истории без номера версии дополняется при старте; повтор ничего не меняет', async () => {
    const datasetId = await createDataset('Откат обновление')
    const history = historyName(datasetId)
    await db().execute(sql.raw(`ALTER TABLE ds."${history}" DROP COLUMN dataset_version`))

    expect(await Physical.upgradeHistoryTables()).toBeGreaterThanOrEqual(1)
    const columns = await db().execute(
      sql`SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'ds' AND table_name = ${history} AND column_name = 'dataset_version'`,
    )
    expect(columns).toHaveLength(1)
    expect(await Physical.upgradeHistoryTables()).toBe(0)

    // Правки до обновления (без номера версии) не отменяются
    const [row] = await insert(datasetId, [{ code: 'A', amount: 1 }])
    await db().execute(sql.raw(`UPDATE ds."${history}" SET dataset_version = NULL`))
    await patch(datasetId, String(row?._id), { amount: 2 })
    const blocked = await rollback(datasetId, 1)
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().detail).toContain('версия 2 — история строк этой версии не сохранена')
  })
})
