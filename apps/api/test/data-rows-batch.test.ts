import { beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Массовая правка строк `POST /datasets/{id}/rows/batch` (P5-E02, ADR-0097):
 * вставка, изменение и удаление одной транзакцией; большая пачка — заданием
 * (`202 + jobId`). Права — те же, что у одиночной правки: чужой датасет не
 * меняется, задание выполняется правами поставившего.
 */
registerLifecycle()

let fx: TestContext
let datasetId = ''
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Пачка ${run}`,
      spaceId: fx.spaceId,
      fields: [
        {
          key: 'code',
          label: { ru: 'Код' },
          type: 'identifier',
          semantic: 'identifier',
          required: true,
        },
        { key: 'amount', label: { ru: 'Число' }, type: 'number', semantic: 'measure' },
      ],
      primaryKey: ['code'],
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  datasetId = created.json().id
})

const batch = (payload: Record<string, unknown>, as = fx.admin) =>
  call(fx.app, { method: 'POST', url: `/datasets/${datasetId}/rows/batch`, as, payload })

async function rowIds(): Promise<Array<{ id: string; code: string }>> {
  const response = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows/query`,
    as: fx.admin,
    payload: { limit: 100 },
  })
  expect(response.statusCode, response.body).toBe(200)
  const body = response.json() as { fields: Array<{ name: string }>; rows: unknown[][] }
  const idIndex = body.fields.findIndex((field) => field.name === '_id')
  const codeIndex = body.fields.findIndex((field) => field.name === 'code')
  return body.rows.map((row) => ({
    id: String(row[idIndex]),
    code: String(row[codeIndex]),
  }))
}

describe('массовая правка строк', () => {
  it('вставляет, меняет и удаляет одним запросом', async () => {
    const inserted = await batch({
      insert: [{ values: { code: 'B-1', amount: 1 } }, { values: { code: 'B-2', amount: 2 } }],
    })
    expect(inserted.statusCode, inserted.body).toBe(200)
    expect(inserted.json()).toEqual({ inserted: 2, updated: 0, deleted: 0 })

    const rows = await rowIds()
    const first = rows.find((row) => row.code === 'B-1')
    const second = rows.find((row) => row.code === 'B-2')

    const mixed = await batch({
      insert: [{ values: { code: 'B-3', amount: 3 } }],
      // Версию можно не присылать: массовый импорт её не знает
      update: [{ id: first?.id ?? '', values: { amount: 42 } }],
      delete: [second?.id ?? ''],
    })
    expect(mixed.statusCode, mixed.body).toBe(200)
    expect(mixed.json()).toEqual({ inserted: 1, updated: 1, deleted: 1 })

    const after = await rowIds()
    expect(after.map((row) => row.code).sort()).toEqual(['B-1', 'B-3'])
  })

  it('пачка применяется целиком: ошибка одной строки откатывает всё', async () => {
    const before = await rowIds()
    const response = await batch({
      insert: [{ values: { code: 'B-9', amount: 9 } }, { values: { amount: 10 } }],
    })
    expect(response.statusCode).toBe(400)
    const after = await rowIds()
    expect(after).toHaveLength(before.length)
  })

  it('пустая пачка отклоняется', async () => {
    const response = await batch({})
    expect(response.statusCode).toBe(400)
  })

  it('большая пачка и `async` отвечают 202 с идентификатором задания', async () => {
    const response = await batch({
      insert: [{ values: { code: 'B-async', amount: 1 } }],
      async: true,
    })
    expect(response.statusCode, response.body).toBe(202)
    const jobId = response.json().jobId as string
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/)

    const job = await call(fx.app, { url: `/jobs/${jobId}`, as: fx.admin })
    expect(job.statusCode).toBe(200)
    expect(job.json().name).toBe('dataset.rows-batch')
  })

  it('без права правки датасета пачка не применяется', async () => {
    const response = await batch(
      { insert: [{ values: { code: 'B-stranger', amount: 1 } }] },
      fx.users.stranger,
    )
    // Датасет посторонний не видит вовсе
    expect(response.statusCode).toBe(404)

    const readOnly = await batch(
      { insert: [{ values: { code: 'B-viewer', amount: 1 } }] },
      fx.users.viewer,
    )
    expect(readOnly.statusCode).toBe(403)
  })
})
