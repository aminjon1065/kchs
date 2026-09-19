import { sql } from 'drizzle-orm'
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
 * Паспорт территории (P2-E04 S05, ADR-0077; сценарий приёмки фазы 2 №5):
 * показатели датасетов с полем территории за период и предыдущий период, по
 * месяцам и по дочерним единицам — с политиками строк смотрящего; показатели,
 * привязанные связью `about_territory`; задачи и поручения с территорией.
 */
registerLifecycle()

const { SpaceService } = await import('../src/kernel/spaces/service.js')
const { TerritoryService } = await import('../src/modules/gis/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const TERRITORIES = (await import('../src/seed/territories.json', { with: { type: 'json' } }))
  .default

let fx: TestContext
let head: TestUser
let incidentsId: string
let objectsId: string
const territory = new Map<string, string>()
const run = Date.now().toString(36)
const DAY = 86_400_000

const id = (code: string) => territory.get(code) as string
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()

async function createDataset(payload: Record<string, unknown>, rows: Record<string, unknown>[]) {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: { spaceId: fx.spaceId, ...payload },
  })
  expect(created.statusCode, created.body).toBe(200)
  const datasetId = created.json().id as string
  const inserted = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows`,
    as: fx.admin,
    payload: { rows: rows.map((values) => ({ values })) },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)
  return datasetId
}

beforeAll(async () => {
  fx = await setupFixture()
  await db().transaction((tx) => TerritoryService.load(tx, systemCtx('test'), TERRITORIES as never))
  await TerritoryService.invalidate()
  for (const item of await TerritoryService.list()) territory.set(item.code, item.id)
  await db().execute(
    sql`UPDATE territories SET geom = ST_Multi(ST_GeomFromText('POLYGON((68.6 38.4, 69 38.4, 69 38.7, 68.6 38.7, 68.6 38.4))', 4326))
        WHERE code LIKE 'TJ-DU%'`,
  )

  incidentsId = await createDataset(
    {
      name: `Происшествия ${run}`,
      timeField: 'occurred_at',
      territoryField: 'territory',
      fields: [
        { key: 'code', label: { ru: 'Номер' }, type: 'identifier', semantic: 'identifier' },
        { key: 'occurred_at', label: { ru: 'Дата' }, type: 'datetime', semantic: 'time' },
        { key: 'kind', label: { ru: 'Вид' }, type: 'text', semantic: 'category' },
        { key: 'territory', label: { ru: 'Территория' }, type: 'territory' },
        { key: 'damage', label: { ru: 'Ущерб' }, type: 'number', semantic: 'measure' },
      ],
    },
    [
      { code: 'I-1', occurred_at: ago(1), kind: 'fire', territory: id('TJ-DU-02'), damage: 100 },
      { code: 'I-2', occurred_at: ago(2), kind: 'flood', territory: id('TJ-DU-02'), damage: 200 },
      { code: 'I-3', occurred_at: ago(3), kind: 'fire', territory: id('TJ-DU-04'), damage: 50 },
      // 13 месяцев назад — предыдущий период
      { code: 'I-4', occurred_at: ago(400), kind: 'fire', territory: id('TJ-DU-02'), damage: 30 },
      // Больше двух лет назад — вне обоих окон
      { code: 'I-5', occurred_at: ago(900), kind: 'fire', territory: id('TJ-DU-01'), damage: 999 },
      // Другой регион
      { code: 'I-6', occurred_at: ago(1), kind: 'fire', territory: id('TJ-SU-01'), damage: 10 },
      // Сам Душанбе, без района
      { code: 'I-7', occurred_at: ago(1), kind: 'fire', territory: id('TJ-DU'), damage: 5 },
    ],
  )
  objectsId = await createDataset(
    {
      name: `Объекты ${run}`,
      territoryField: 'territory',
      fields: [
        { key: 'name', label: { ru: 'Название' }, type: 'text' },
        { key: 'territory', label: { ru: 'Территория' }, type: 'territory' },
        { key: 'capacity', label: { ru: 'Вместимость' }, type: 'integer', semantic: 'measure' },
      ],
    },
    [
      { name: 'Школа 1', territory: id('TJ-DU-02'), capacity: 300 },
      { name: 'Школа 2', territory: id('TJ-DU-04'), capacity: 200 },
      { name: 'Школа 3', territory: id('TJ-KT'), capacity: 100 },
    ],
  )

  // Глава района Сино: читатель пространства, в «Происшествиях» — только свой район
  head = await createUser(fx.app, 'district_head', ['employee'])
  await db().transaction((tx) =>
    SpaceService.addMember(tx, systemCtx('test'), fx.spaceId, head.id, 'viewer'),
  )
  await redis().del(`kchs:principals:${head.id}`)
  const policy = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${incidentsId}/policies/rows`,
    as: fx.admin,
    payload: {
      principal: { type: 'user', id: head.id },
      filter: { field: 'territory', op: 'within', value: id('TJ-DU-02') },
    },
  })
  expect(policy.statusCode, policy.body).toBe(200)
})

async function passport(code: string, as: TestUser = fx.admin, period = '12m') {
  const response = await call(fx.app, {
    url: `/gis/territories/${id(code)}/passport?period=${period}`,
    as,
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

interface DatasetStats {
  id: string
  rows: number | null
  previousRows: number | null
  measures: Array<{ key: string; value: number | null; previous: number | null }>
  series: Array<{ period: string; rows: number }>
  children: Record<string, number>
}

const datasetOf = (body: { datasets: DatasetStats[] }, datasetId: string) =>
  body.datasets.find((item) => item.id === datasetId) as DatasetStats

describe('паспорт территории: показатели датасетов', () => {
  it('строки и суммы мер за 12 месяцев и предыдущие 12, по месяцам и районам', async () => {
    const body = await passport('TJ-DU')
    expect(body).toMatchObject({ territoryId: id('TJ-DU'), period: '12m', childLevel: 'district' })
    expect(body.window.to >= body.window.from).toBe(true)
    expect(body.children.map((child: { code: string }) => child.code)).toEqual([
      'TJ-DU-01',
      'TJ-DU-02',
      'TJ-DU-03',
      'TJ-DU-04',
    ])
    expect(body.children[1]).toMatchObject({ population: 400_000, hasGeometry: true })

    const incidents = datasetOf(body, incidentsId)
    // I-1, I-2, I-3 и сам Душанбе (I-7); I-4 — в предыдущем периоде
    expect(incidents).toMatchObject({
      rows: 4,
      previousRows: 1,
      territoryField: 'territory',
      timeField: 'occurred_at',
      error: null,
    })
    expect(incidents.measures).toEqual([
      expect.objectContaining({ key: 'damage', value: 355, previous: 30 }),
    ])
    expect(incidents.series).toHaveLength(12)
    expect(incidents.series.reduce((sum, item) => sum + item.rows, 0)).toBe(4)
    expect(incidents.children).toEqual({ [id('TJ-DU-02')]: 2, [id('TJ-DU-04')]: 1 })

    // Без поля времени — за всё время, без сравнения
    const objects = datasetOf(body, objectsId)
    expect(objects).toMatchObject({ rows: 2, previousRows: null, series: [] })
    expect(objects.measures[0]).toMatchObject({ key: 'capacity', value: 500 })
  })

  it('политика строк смотрящего: глава района видит только свой район', async () => {
    const body = await passport('TJ-DU', head)
    const incidents = datasetOf(body, incidentsId)
    expect(incidents).toMatchObject({ rows: 2, previousRows: 1 })
    expect(incidents.measures[0]).toMatchObject({ value: 300, previous: 30 })
    expect(incidents.children).toEqual({ [id('TJ-DU-02')]: 2 })
    // Датасет без политик — целиком
    expect(datasetOf(body, objectsId).rows).toBe(2)
    // Чужой не видит датасетов пространства — и в паспорте их нет
    const stranger = await passport('TJ-DU', fx.users.stranger)
    expect(stranger.datasets.map((item: { id: string }) => item.id)).not.toContain(incidentsId)
  })

  it('период «всё время» и «год»; единица без дочерних', async () => {
    const all = datasetOf(await passport('TJ-DU', fx.admin, 'all'), incidentsId)
    expect(all).toMatchObject({ rows: 6, previousRows: null, series: [] })
    const sino = await passport('TJ-DU-02', fx.admin, 'year')
    expect(sino.childLevel).toBeNull()
    expect(sino.window.from.endsWith('-01-01')).toBe(true)
    expect(datasetOf(sino, incidentsId).children).toEqual({})

    const unknown = await call(fx.app, {
      url: '/gis/territories/0190a1b2-0000-7000-8000-00000000ffff/passport',
      as: fx.admin,
    })
    expect(unknown.statusCode).toBe(404)
  })
})

describe('паспорт территории: поручения и показатели', () => {
  it('задачи с территорией: счётчики паспорта и список с вложенными единицами', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/tasks',
      as: fx.admin,
      payload: {
        kind: 'instruction',
        title: `Проверить дамбу ${run}`,
        spaceId: fx.spaceId,
        assigneeId: fx.users.member.id,
        dueAt: ago(2),
        territoryId: id('TJ-DU-04'),
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const taskId = created.json().id
    const task = (await call(fx.app, { url: `/tasks/${taskId}`, as: fx.admin })).json()
    expect(task.territoryId).toBe(id('TJ-DU-04'))

    expect((await passport('TJ-DU')).tasks).toEqual({ open: 1, overdue: 1, closed: 0 })
    const list = await call(fx.app, {
      url: `/tasks?scope=all&state=all&territoryId=${id('TJ-DU')}`,
      as: fx.admin,
    })
    expect(list.json().items.map((item: { id: string }) => item.id)).toEqual([taskId])
    const other = await call(fx.app, {
      url: `/tasks?scope=all&state=all&territoryId=${id('TJ-DU-02')}`,
      as: fx.admin,
    })
    expect(other.json().items).toEqual([])

    const unknown = await call(fx.app, {
      method: 'PATCH',
      url: `/tasks/${taskId}`,
      as: fx.admin,
      payload: { territoryId: '0190a1b2-0000-7000-8000-00000000ffff' },
    })
    expect(unknown.statusCode).toBe(400)

    const moved = await call(fx.app, {
      method: 'PATCH',
      url: `/tasks/${taskId}`,
      as: fx.admin,
      payload: { territoryId: id('TJ-DU-02') },
    })
    expect(moved.statusCode, moved.body).toBe(200)
    expect(moved.json().territoryId).toBe(id('TJ-DU-02'))
    const events = await db().execute<{ type: string; payload: Record<string, unknown> }>(
      sql`SELECT type, event->'payload' AS payload FROM ops.outbox
           WHERE event->'object'->>'id' = ${taskId} AND type = 'task.territory_changed'`,
    )
    expect(events[0]?.payload).toMatchObject({ from: id('TJ-DU-04'), to: id('TJ-DU-02') })
  })

  it('поручение из строки датасета получает территорию строки', async () => {
    const rows = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${incidentsId}/rows/query`,
      as: fx.admin,
      payload: { where: { field: 'code', op: 'eq', value: 'I-3' }, limit: 1 },
    })
    expect(rows.statusCode, rows.body).toBe(200)
    const page = rows.json() as { fields: Array<{ name: string }>; rows: unknown[][] }
    const rowId = String(page.rows[0]?.[page.fields.findIndex((field) => field.name === '_id')])
    const created = await call(fx.app, {
      method: 'POST',
      url: '/tasks',
      as: fx.admin,
      payload: {
        title: `Разобрать происшествие ${run}`,
        spaceId: fx.spaceId,
        source: { kind: 'dataset_row', datasetId: incidentsId, rowId, label: 'I-3' },
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const task = (await call(fx.app, { url: `/tasks/${created.json().id}`, as: fx.admin })).json()
    expect(task.territoryId).toBe(id('TJ-DU-04'))
  })

  it('показатель, привязанный к стране, считается по территории паспорта', async () => {
    const metric = await call(fx.app, {
      method: 'POST',
      url: '/metrics',
      as: fx.admin,
      payload: {
        name: `Происшествий всего ${run}`,
        spaceId: fx.spaceId,
        datasetId: incidentsId,
        definition: { measure: { agg: 'count' }, period: null, comparison: 'none' },
      },
    })
    expect(metric.statusCode, metric.body).toBe(200)
    const metricId = metric.json().id
    const linked = await call(fx.app, {
      method: 'POST',
      url: `/objects/${metricId}/links`,
      as: fx.admin,
      payload: { targetId: id('TJ'), kind: 'about_territory' },
    })
    expect(linked.statusCode, linked.body).toBe(200)

    const body = await passport('TJ-DU')
    expect(body.metrics).toEqual([
      expect.objectContaining({ metricId, linkedTo: id('TJ'), value: 6 }),
    ])
    // Политика главы района действует и в показателе
    const own = await passport('TJ-DU', head)
    expect(own.metrics[0]).toMatchObject({ metricId, value: 3 })
    // Показатель чужого пространства не виден — и не раскрывается
    expect((await passport('TJ-DU', fx.users.stranger)).metrics).toEqual([])
  })
})
