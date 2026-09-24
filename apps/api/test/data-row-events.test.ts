import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * События строк датасета для правил автоматизации (ADR-0133): включаются настройкой
 * `rowEvents`, несут значения без чувствительных полей, подписи вариантов и путь
 * территории кодами; пакет больше предела и выключенная настройка публикуют только
 * сводное `dataset.rows_changed`; условие правила отбирает строки по значениям.
 */
registerLifecycle()

const { TerritoryService } = await import('../src/modules/gis/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const json = { with: { type: 'json' } } as const
const TERRITORIES = (await import('../src/seed/territories.json', json)).default

let fx: TestContext
let datasetId: string

interface OutboxEvent {
  type: string
  payload: Record<string, unknown>
  changedFields: string[] | null
}

async function eventsOf(dataset: string, type: string): Promise<OutboxEvent[]> {
  const rows = await db().execute<{ event: OutboxEvent }>(
    sql`SELECT event FROM ops.outbox
         WHERE type = ${type} AND event->'object'->>'id' = ${dataset}
         ORDER BY id`,
  )
  return rows.map((row) => row.event)
}

async function createDataset(name: string, rowEvents: boolean): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name,
      spaceId: fx.spaceId,
      primaryKey: ['code'],
      territoryField: 'territory',
      settings: { rowEvents },
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier', required: true },
        { key: 'magnitude', label: { ru: 'Магнитуда' }, type: 'number' },
        {
          key: 'status',
          label: { ru: 'Статус' },
          type: 'select',
          options: [
            { value: 'new', label: { ru: 'Новое' } },
            { value: 'reviewed', label: { ru: 'Рассмотрено' } },
          ],
          default: 'new',
        },
        { key: 'territory', label: { ru: 'Район' }, type: 'territory' },
        { key: 'note', label: { ru: 'Служебная пометка' }, type: 'text', sensitive: true },
        { key: 'geometry', label: { ru: 'Геометрия' }, type: 'geometry' },
      ],
    },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id
}

async function insert(dataset: string, rows: Array<Record<string, unknown>>) {
  const response = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${dataset}/rows`,
    as: fx.admin,
    payload: { rows: rows.map((values) => ({ values })) },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as {
    items: Array<{ _id: string; _ver: number; values: Record<string, unknown> }>
  }
}

beforeAll(async () => {
  fx = await setupFixture()
  await db().transaction((tx) => TerritoryService.load(tx, systemCtx('test'), TERRITORIES as never))
  await TerritoryService.invalidate()
  datasetId = await createDataset('Сообщения об опасных явлениях', true)
})

describe('события строк', () => {
  it('вставка публикует значения, подписи и путь территории без чувствительных полей', async () => {
    await insert(datasetId, [
      {
        code: 'usgs:us6000tx16',
        magnitude: 4.7,
        status: 'new',
        territory: 'TJ-GB-04',
        note: 'не для рассылки',
        geometry: { type: 'Point', coordinates: [71.768, 37.2772] },
      },
    ])
    const [event] = await eventsOf(datasetId, 'dataset.row_created')
    expect(event?.payload.values).toMatchObject({
      code: 'usgs:us6000tx16',
      magnitude: 4.7,
      status: 'new',
      geometry: { type: 'Point' },
    })
    expect(event?.payload.values).not.toHaveProperty('note')
    expect(event?.payload.labels).toMatchObject({ status: 'Новое', territory: 'Ишкашим' })
    expect(event?.payload.territories).toMatchObject({
      territory: { code: 'TJ-GB-04', path: ['TJ', 'TJ-GB', 'TJ-GB-04'] },
    })
    // Сводное событие по-прежнему публикуется
    expect(await eventsOf(datasetId, 'dataset.rows_changed')).toHaveLength(1)
  })

  it('правка публикует изменённые поля и прежние значения', async () => {
    const created = await insert(datasetId, [{ code: 'emsc:1', magnitude: 3.1, status: 'new' }])
    const row = created.items[0] as { _id: string; _ver: number }
    const response = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${datasetId}/rows/${row._id}`,
      as: fx.admin,
      payload: { values: { status: 'reviewed' }, ver: row._ver },
    })
    expect(response.statusCode, response.body).toBe(200)
    const updates = await eventsOf(datasetId, 'dataset.row_updated')
    const event = updates.at(-1)
    expect(event?.payload).toMatchObject({
      rowId: row._id,
      changed: ['status'],
      previous: { status: 'new' },
      values: { code: 'emsc:1', status: 'reviewed' },
      labels: { status: 'Рассмотрено' },
    })
    expect(event?.changedFields).toEqual(['status'])

    const removed = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/rows/delete`,
      as: fx.admin,
      payload: { ids: [row._id] },
    })
    expect(removed.statusCode, removed.body).toBe(200)
    const deletions = await eventsOf(datasetId, 'dataset.row_deleted')
    expect(deletions.at(-1)?.payload).toMatchObject({ rowId: row._id, values: { code: 'emsc:1' } })
  })

  it('поле без значения при вставке получает значение по умолчанию', async () => {
    const created = await insert(datasetId, [{ code: 'default-1', magnitude: 2 }])
    const row = created.items[0]
    expect(row?.values.status).toBe('new')
    const events = await eventsOf(datasetId, 'dataset.row_created')
    expect(events.at(-1)?.payload).toMatchObject({
      values: { code: 'default-1', status: 'new' },
      labels: { status: 'Новое' },
    })
  })

  it('выключенная настройка и большой пакет — только сводное событие', async () => {
    const quiet = await createDataset('Без событий строк', false)
    await insert(quiet, [{ code: 'a-1', magnitude: 1 }])
    expect(await eventsOf(quiet, 'dataset.row_created')).toHaveLength(0)
    expect(await eventsOf(quiet, 'dataset.rows_changed')).toHaveLength(1)

    const before = (await eventsOf(datasetId, 'dataset.row_created')).length
    await insert(
      datasetId,
      Array.from({ length: 201 }, (_, index) => ({ code: `bulk-${index}`, magnitude: 1 })),
    )
    expect(await eventsOf(datasetId, 'dataset.row_created')).toHaveLength(before)
  })

  it('условие правила отбирает строки по значениям и территории', async () => {
    await insert(datasetId, [
      { code: 'usgs:strong', magnitude: 5.2, territory: 'TJ-GB-01' },
      { code: 'usgs:weak', magnitude: 2.4, territory: 'TJ-GB-01' },
      { code: 'usgs:far', magnitude: 5.9, territory: 'TJ-SU-01' },
    ])
    const response = await call(fx.app, {
      method: 'POST',
      url: '/automation/rules/dry-run',
      as: fx.admin,
      payload: {
        limit: 50,
        definition: {
          name: { ru: 'Сильное землетрясение в ГБАО' },
          runAs: null,
          trigger: {
            kind: 'event',
            type: 'dataset.row_created',
            filter: { 'object.id': datasetId },
          },
          conditions: {
            and: [
              { expr: 'event.payload.values.magnitude >= 4.5' },
              { expr: "contains(event.payload.territories.territory.path, 'TJ-GB')" },
            ],
          },
          actions: [
            {
              type: 'notify',
              to: ['author'],
              text: 'M{{event.payload.values.magnitude}}, {{event.payload.labels.territory}}',
            },
          ],
        },
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    const items = (
      response.json() as {
        items: Array<{ matched: boolean; actions: Array<{ summary?: string }> }>
      }
    ).items
    const matched = items.filter((item) => item.matched)
    // Сильное в ГБАО из этого теста и первое (M4.7, Ишкашим) — не слабое и не в Согде
    expect(matched).toHaveLength(2)
  })
})
