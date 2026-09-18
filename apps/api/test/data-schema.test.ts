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

/** Правка схемы датасета (P1-E01 S01–S02, ADR-0047). */
registerLifecycle()

let fx: TestContext
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
})

async function createDataset(name: string, extra: Record<string, unknown> = {}) {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `${name} ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
        { key: 'amount', label: { ru: 'Сумма' }, type: 'text', indexed: true },
        { key: 'day', label: { ru: 'Дата' }, type: 'date', semantic: 'time' },
      ],
      primaryKey: ['code'],
      timeField: 'day',
      ...extra,
    },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

async function physicalOf(datasetId: string) {
  const [meta] = await db().execute<{ physical_table: string }>(
    sql`SELECT physical_table FROM datasets WHERE id = ${datasetId}`,
  )
  const fields = await db().execute<{ key: string; physical_column: string }>(
    sql`SELECT key, physical_column FROM dataset_fields WHERE dataset_id = ${datasetId}`,
  )
  return {
    table: meta?.physical_table as string,
    column: Object.fromEntries(fields.map((field) => [field.key, field.physical_column])),
  }
}

/** Строки — прямо в физическую таблицу: API строк здесь не проверяется. */
async function insertRows(datasetId: string, rows: Array<Record<string, string | null>>) {
  const { table, column } = await physicalOf(datasetId)
  for (const row of rows) {
    const keys = Object.keys(row)
    await db().execute(
      sql`INSERT INTO ${sql.raw(`ds."${table}"`)} (${sql.raw(keys.map((key) => column[key]).join(', '))})
          VALUES (${sql.join(
            keys.map((key) => sql`${row[key]}`),
            sql`, `,
          )})`,
    )
  }
  await db().execute(sql`UPDATE datasets SET row_count = ${rows.length} WHERE id = ${datasetId}`)
}

async function columnIndexes(table: string, column: string) {
  return db().execute<{ unique: boolean; def: string }>(
    sql`SELECT x.indisunique AS unique, pg_get_indexdef(x.indexrelid) AS def
          FROM pg_index x
          JOIN pg_class t ON t.oid = x.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (x.indkey)
         WHERE n.nspname = 'ds' AND t.relname = ${table} AND a.attname = ${column}
           AND NOT x.indisprimary`,
  )
}

const fieldsOf = async (datasetId: string) =>
  (await call(fx.app, { url: `/datasets/${datasetId}`, as: fx.admin })).json()

describe('поля: добавление, описание, удаление', () => {
  it('новое поле получает следующий физический столбец; структурная правка — версия schema', async () => {
    const id = await createDataset('Поля')
    const added = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${id}/fields`,
      as: fx.admin,
      payload: { key: 'district', label: { ru: 'Район' }, type: 'text', indexed: true },
    })
    expect(added.statusCode, added.body).toBe(200)
    expect(added.json()).toMatchObject({ currentVersion: 2, schemaVersion: 2 })
    expect(added.json().fields.map((field: { key: string }) => field.key)).toContain('district')

    const { table, column } = await physicalOf(id)
    expect(column.district).toBe('c_4')
    expect((await columnIndexes(table, 'c_4'))[0]?.def).toContain('gin_trgm_ops')

    const versions = await call(fx.app, { url: `/datasets/${id}/versions`, as: fx.admin })
    expect(versions.json().items[0]).toMatchObject({ number: 2, origin: 'schema' })
    const events = await db().execute<{ payload: { change: string; fields: string[] } }>(
      sql`SELECT event->'payload' AS payload FROM ops.outbox
           WHERE type = 'dataset.schema_changed' AND event->'object'->>'id' = ${id}`,
    )
    expect(events.map((row) => row.payload)).toEqual([{ change: 'added', fields: ['district'] }])

    const duplicate = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${id}/fields`,
      as: fx.admin,
      payload: { key: 'district', label: { ru: 'Район' }, type: 'text' },
    })
    expect(duplicate.statusCode).toBe(409)
  })

  it('описание поля меняется без версии данных; индекс снимается и ставится', async () => {
    const id = await createDataset('Описание')
    const { table, column } = await physicalOf(id)
    expect(await columnIndexes(table, column.amount as string)).toHaveLength(1)

    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${id}/fields/amount`,
      as: fx.admin,
      payload: {
        label: { ru: 'Сумма, сомони', en: 'Amount' },
        semantic: 'measure',
        unit: 'TJS',
        indexed: false,
        options: [{ value: 'a', label: { ru: 'А' } }],
      },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    expect(patched.json()).toMatchObject({ currentVersion: 1, schemaVersion: 2 })
    const field = patched.json().fields.find((item: { key: string }) => item.key === 'amount')
    expect(field).toMatchObject({
      label: { ru: 'Сумма, сомони', en: 'Amount' },
      semantic: 'measure',
      unit: 'TJS',
      indexed: false,
      options: [{ value: 'a', label: { ru: 'А' } }],
    })
    expect(await columnIndexes(table, column.amount as string)).toHaveLength(0)

    const unknown = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${id}/fields/nope`,
      as: fx.admin,
      payload: { label: { ru: 'Нет' } },
    })
    expect(unknown.statusCode).toBe(404)
  })

  it('справочник: поля ключа и подписи должны быть в датасете-справочнике', async () => {
    const reference = await call(fx.app, {
      method: 'POST',
      url: '/datasets',
      as: fx.admin,
      payload: {
        name: `Типы ${run}`,
        spaceId: fx.spaceId,
        kind: 'reference',
        fields: [
          { key: 'code', label: { ru: 'Код' }, type: 'identifier' },
          { key: 'name', label: { ru: 'Название' }, type: 'text' },
        ],
        primaryKey: ['code'],
      },
    })
    const referenceId = reference.json().id as string
    const id = await createDataset('Со справочником')

    const linked = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${id}/fields/amount`,
      as: fx.admin,
      payload: { lookup: { datasetId: referenceId, keyField: 'code', labelField: 'name' } },
    })
    expect(linked.statusCode, linked.body).toBe(200)
    expect(
      linked.json().fields.find((item: { key: string }) => item.key === 'amount').lookup,
    ).toEqual({ datasetId: referenceId, keyField: 'code', labelField: 'name' })

    const wrong = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${id}/fields/amount`,
      as: fx.admin,
      payload: { lookup: { datasetId: referenceId, keyField: 'code', labelField: 'title' } },
    })
    expect(wrong.statusCode).toBe(400)

    // Поле, на которое ссылается справочник, удалить нельзя
    const removeUsed = await call(fx.app, {
      method: 'DELETE',
      url: `/datasets/${referenceId}/fields/name`,
      as: fx.admin,
    })
    expect(removeUsed.statusCode).toBe(409)

    const unlinked = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${id}/fields/amount`,
      as: fx.admin,
      payload: { lookup: null },
    })
    expect(
      unlinked.json().fields.find((item: { key: string }) => item.key === 'amount').lookup,
    ).toBeUndefined()
  })

  it('удаление поля: столбец уходит, поле времени сбрасывается, поле ключа — конфликт', async () => {
    const id = await createDataset('Удаление')
    const { table, column } = await physicalOf(id)
    const keyField = await call(fx.app, {
      method: 'DELETE',
      url: `/datasets/${id}/fields/code`,
      as: fx.admin,
    })
    expect(keyField.statusCode).toBe(409)

    const removed = await call(fx.app, {
      method: 'DELETE',
      url: `/datasets/${id}/fields/day`,
      as: fx.admin,
    })
    expect(removed.statusCode, removed.body).toBe(200)
    expect(removed.json()).toMatchObject({ timeField: null, currentVersion: 2 })
    const columns = await db().execute(
      sql`SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'ds' AND table_name = ${table} AND column_name = ${column.day}`,
    )
    expect(columns).toHaveLength(0)

    // Обычное поле (не время и не территория) — тоже удаляется
    const plain = await call(fx.app, {
      method: 'DELETE',
      url: `/datasets/${id}/fields/amount`,
      as: fx.admin,
    })
    expect(plain.statusCode, plain.body).toBe(200)
    expect(plain.json().fields.map((field: { key: string }) => field.key)).toEqual(['code'])
  })
})

describe('смена типа поля', () => {
  it('пробный прогон считает неприводимые значения; применение — только с согласия на потерю', async () => {
    const id = await createDataset('Тип')
    await insertRows(id, [
      { code: 'A', amount: '12' },
      { code: 'B', amount: ' 7.5 ' },
      { code: 'C', amount: 'двенадцать' },
      { code: 'D', amount: '' },
      { code: 'E', amount: null },
    ])

    const dry = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${id}/fields/amount/convert`,
      as: fx.admin,
      payload: { type: 'number' },
    })
    expect(dry.statusCode, dry.body).toBe(200)
    expect(dry.json()).toMatchObject({ total: 3, failed: 1, applied: false })
    expect(dry.json().sample).toEqual([{ rowId: expect.any(String), value: 'двенадцать' }])

    const refused = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${id}/fields/amount/convert`,
      as: fx.admin,
      payload: { type: 'number', dryRun: false },
    })
    expect(refused.statusCode).toBe(409)

    const applied = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${id}/fields/amount/convert`,
      as: fx.admin,
      payload: { type: 'number', dryRun: false, allowLoss: true },
    })
    expect(applied.statusCode, applied.body).toBe(200)
    expect(applied.json()).toMatchObject({ failed: 1, applied: true })

    const { table, column } = await physicalOf(id)
    const values = await db().execute<{ v: number | null }>(
      sql.raw(`SELECT ${column.amount} AS v FROM ds."${table}" ORDER BY _id`),
    )
    expect(values.map((row) => row.v)).toEqual([12, 7.5, null, null, null])
    // Индекс поля пересоздан для нового типа (B-tree вместо trigram)
    const indexes = await columnIndexes(table, column.amount as string)
    expect(indexes).toHaveLength(1)
    expect(indexes[0]?.def).not.toContain('gin_trgm_ops')

    const record = await fieldsOf(id)
    expect(record.fields.find((item: { key: string }) => item.key === 'amount')).toMatchObject({
      type: 'number',
      semantic: 'measure',
    })
    expect(record.currentVersion).toBe(2)
  })

  it('совпадение значений ключа после смены типа — конфликт; геометрия не приводится', async () => {
    const id = await createDataset('Ключ типа')
    await insertRows(id, [{ code: '1' }, { code: '1.0' }])
    const collision = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${id}/fields/code/convert`,
      as: fx.admin,
      payload: { type: 'number', dryRun: false },
    })
    expect(collision.statusCode, collision.body).toBe(409)
    expect(collision.body).toContain('ключа')

    const geometry = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${id}/fields/amount/convert`,
      as: fx.admin,
      payload: { type: 'geometry' },
    })
    expect(geometry.statusCode).toBe(400)
  })
})

describe('настройки датасета', () => {
  it('ключ строки: повторы — конфликт, иначе уникальный индекс перестраивается', async () => {
    const id = await createDataset('Настройки')
    await insertRows(id, [
      { code: 'A', amount: 'x' },
      { code: 'B', amount: 'x' },
    ])
    const duplicates = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${id}`,
      as: fx.admin,
      payload: { primaryKey: ['amount'] },
    })
    expect(duplicates.statusCode).toBe(409)

    const changed = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${id}`,
      as: fx.admin,
      payload: {
        primaryKey: ['code', 'amount'],
        description: 'Описание',
        settings: { editable: false },
      },
    })
    expect(changed.statusCode, changed.body).toBe(200)
    expect(changed.json()).toMatchObject({
      primaryKey: ['code', 'amount'],
      description: 'Описание',
      settings: { editable: false, trackHistory: true },
      currentVersion: 2,
    })
    const { table, column } = await physicalOf(id)
    const unique = (await columnIndexes(table, column.amount as string)).filter((i) => i.unique)
    expect(unique).toHaveLength(1)
    expect(unique[0]?.def).toContain(`(${column.code}, ${column.amount})`)

    const badTime = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${id}`,
      as: fx.admin,
      payload: { timeField: 'amount' },
    })
    expect(badTime.statusCode).toBe(400)
  })

  it('правка схемы — только с уровнем manage; во время импорта — конфликт', async () => {
    const id = await createDataset('Права схемы')
    for (const user of [fx.users.member, fx.users.viewer]) {
      const response = await call(fx.app, {
        method: 'POST',
        url: `/datasets/${id}/fields`,
        as: user,
        payload: { key: 'x', label: { ru: 'X' }, type: 'text' },
      })
      expect(response.statusCode).toBe(403)
    }

    const file = await uploadFile(fx.app, fx.admin, {
      spaceId: fx.spaceId,
      name: `schema-${run}.csv`,
      content: 'code\n',
      mime: 'text/csv',
    })
    const started = await call(fx.app, {
      method: 'POST',
      url: '/datasets/imports',
      as: fx.admin,
      payload: {
        fileId: file.id,
        target: { kind: 'existing', datasetId: id, mode: 'append' },
        mapping: [
          {
            column: 0,
            fieldKey: 'code',
            label: { ru: 'Код' },
            type: 'identifier',
            semantic: 'identifier',
          },
        ],
      },
    })
    expect(started.statusCode, started.body).toBe(200)
    const blocked = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${id}/fields/amount/convert`,
      as: fx.admin,
      payload: { type: 'number' },
    })
    expect(blocked.statusCode).toBe(409)
    // Описание поля во время импорта менять можно — и прежний флаг индекса тоже
    const label = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${id}/fields/amount`,
      as: fx.admin,
      payload: { label: { ru: 'Сумма' }, indexed: true },
    })
    expect(label.statusCode, label.body).toBe(200)
    const index = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${id}/fields/amount`,
      as: fx.admin,
      payload: { indexed: false },
    })
    expect(index.statusCode).toBe(409)
  })
})
