import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Ленты по адресу (ADR-0132): источник вида `feed` забирает GeoJSON по URL и пишет
 * строки по ключу через правку строк — новые вставляет, у знакомых обновляет
 * только поля ленты, ручные поля дежурного сохраняет, удалённые вручную заново не
 * заводит; точку привязывает к району по границе. Лента — локальный сервер с
 * живым ответом USGS (адреса loopback тестовой среде открыты).
 */
registerLifecycle()

const { SourceService } = await import('../src/modules/data/domain/source-service.js')
const { JobService } = await import('../src/kernel/jobs/service.js')
const { TerritoryService } = await import('../src/modules/gis/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const json = { with: { type: 'json' } } as const
const TERRITORIES = (await import('../src/seed/territories.json', json)).default
const BOUNDARIES = (await import('../src/seed/territory-boundaries.json', json)).default

const USGS = JSON.parse(
  readFileSync(new URL('./fixtures/feeds/usgs.geojson', import.meta.url), 'utf8'),
) as { type: string; features: Array<{ id: string; properties: Record<string, unknown> }> }

let fx: TestContext
let server: Server
let base = ''
const run = Date.now().toString(36)
/** Что сейчас отдаёт «лента»: по пути — тело, код и тип. */
const responses = new Map<string, { status: number; type: string; body: string }>()

const serve = (path: string, body: unknown, status = 200, type = 'application/geo+json') =>
  responses.set(path, {
    status,
    type,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

beforeAll(async () => {
  fx = await setupFixture()
  await db().transaction(async (tx) => {
    await TerritoryService.load(tx, systemCtx('test'), TERRITORIES as never)
    await TerritoryService.loadBoundaries(tx, systemCtx('test'), BOUNDARIES)
  })
  await TerritoryService.invalidate()
  server = createServer((request, response) => {
    const found = responses.get(request.url ?? '')
    if (!found) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(found.status, { 'content-type': found.type })
    response.end(found.body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  serve('/usgs.geojson', USGS)
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

/** Датасет «Сообщения об опасных явлениях»: поля ленты и ручной статус дежурного. */
async function createDataset(name: string) {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name,
      spaceId: fx.spaceId,
      fields: [
        {
          key: 'event_id',
          label: { ru: 'Событие' },
          type: 'identifier',
          semantic: 'identifier',
          required: true,
        },
        { key: 'source', label: { ru: 'Источник' }, type: 'text', semantic: 'category' },
        { key: 'magnitude', label: { ru: 'Магнитуда' }, type: 'number', semantic: 'measure' },
        { key: 'place', label: { ru: 'Место' }, type: 'text', semantic: 'text' },
        { key: 'occurred_at', label: { ru: 'Время' }, type: 'datetime', semantic: 'time' },
        { key: 'geometry', label: { ru: 'Точка' }, type: 'geometry', semantic: 'geometry' },
        { key: 'district', label: { ru: 'Район' }, type: 'territory', semantic: 'territory' },
        { key: 'status', label: { ru: 'Статус' }, type: 'text', semantic: 'category' },
      ],
      primaryKey: ['event_id'],
      timeField: 'occurred_at',
      territoryField: 'district',
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  return created.json().id as string
}

const feedConfig = (url: string, extra: Record<string, unknown> = {}) => ({
  url,
  format: 'geojson',
  mapping: [
    { field: 'event_id', value: { kind: 'path', path: 'id' } },
    { field: 'source', value: { kind: 'const', value: 'USGS' } },
    { field: 'magnitude', value: { kind: 'path', path: 'properties.mag' } },
    { field: 'place', value: { kind: 'path', path: 'properties.place' } },
    { field: 'occurred_at', value: { kind: 'path', path: 'properties.time' } },
  ],
  geometry: { kind: 'feature' },
  geometryField: 'geometry',
  territoryField: 'district',
  keyFields: ['event_id'],
  ...extra,
})

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

async function sync(sourceId: string) {
  const started = await call(fx.app, {
    method: 'POST',
    url: `/sources/${sourceId}/sync`,
    as: fx.admin,
  })
  expect(started.statusCode, started.body).toBe(200)
  return started.json().jobId as string
}

/** Строки датасета: ключ → значения и служебные поля (ответ запроса — столбцами). */
async function rowsOf(datasetId: string) {
  const response = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows/query`,
    as: fx.admin,
    payload: { limit: 100 },
  })
  expect(response.statusCode, response.body).toBe(200)
  const body = response.json() as { fields: Array<{ name: string }>; rows: unknown[][] }
  const rows = body.rows.map((row) =>
    Object.fromEntries(body.fields.map((field, index) => [field.name, row[index]])),
  )
  return new Map(
    rows.map((row) => [
      String(row.event_id),
      { _id: String(row._id), _ver: Number(row._ver), values: row },
    ]),
  )
}

async function codeOf(territoryId: unknown): Promise<string | null> {
  if (typeof territoryId !== 'string') return null
  const [row] = await db().execute<{ code: string }>(
    sql`SELECT code FROM territories WHERE id = ${territoryId}::uuid`,
  )
  return row?.code ?? null
}

describe('лента по адресу: предпросмотр и заведение', () => {
  it('предпросмотр отдаёт записи и пути с типами', async () => {
    const preview = await call(fx.app, {
      method: 'POST',
      url: '/sources/feed/preview',
      as: fx.admin,
      payload: { url: `${base}/usgs.geojson`, format: 'geojson' },
    })
    expect(preview.statusCode, preview.body).toBe(200)
    const body = preview.json() as {
      total: number
      items: Array<Record<string, unknown>>
      paths: Array<{ path: string; type: string }>
    }
    expect(body.total).toBe(10)
    expect(body.items[0]).toMatchObject({ id: 'us6000tx16', 'properties.mag': 4.7 })
    const types = new Map(body.paths.map((path) => [path.path, path.type]))
    expect(types.get('properties.time')).toBe('datetime')
    expect(types.get('geometry')).toBe('geometry')
  })

  it('рядовой сотрудник ленту не заводит и не просматривает', async () => {
    const preview = await call(fx.app, {
      method: 'POST',
      url: '/sources/feed/preview',
      as: fx.users.member,
      payload: { url: `${base}/usgs.geojson`, format: 'geojson' },
    })
    expect(preview.statusCode).toBe(403)
    const created = await call(fx.app, {
      method: 'POST',
      url: '/sources/feeds',
      as: fx.users.member,
      payload: {
        name: `Чужая лента ${run}`,
        spaceId: fx.spaceId,
        feed: feedConfig(`${base}/usgs.geojson`),
        target: { kind: 'new', name: 'x', fields: [] },
      },
    })
    expect(created.statusCode).toBe(403)
  })

  it('настройка проверяется против полей датасета', async () => {
    const datasetId = await createDataset(`Проверка настройки ${run}`)
    const create = (feed: Record<string, unknown>) =>
      call(fx.app, {
        method: 'POST',
        url: '/sources/feeds',
        as: fx.admin,
        payload: {
          name: `Неверная лента ${run}`,
          spaceId: fx.spaceId,
          feed,
          target: { kind: 'existing', datasetId },
        },
      })
    const noKey = await create(feedConfig(`${base}/usgs.geojson`, { keyFields: ['status'] }))
    expect(noKey.statusCode).toBe(400)
    expect(noKey.json().detail).toMatch(/Ключевое поле «status» должна заполнять лента/)
    const secret = await create(feedConfig(`${base}/usgs/{secret:apiKey}.geojson`))
    expect(secret.statusCode).toBe(400)
    expect(secret.json().detail).toMatch(/ссылается на секрет/)
    const wrongType = await create(feedConfig(`${base}/usgs.geojson`, { territoryField: 'place' }))
    expect(wrongType.statusCode).toBe(400)
  })
})

describe('лента по адресу: опросы', () => {
  let sourceId = ''
  let datasetId = ''

  it('первый опрос вставляет записи и привязывает их к районам', async () => {
    datasetId = await createDataset(`Опасные явления ${run}`)
    const created = await call(fx.app, {
      method: 'POST',
      url: '/sources/feeds',
      as: fx.admin,
      payload: {
        name: `USGS ${run}`,
        spaceId: fx.spaceId,
        feed: feedConfig(`${base}/usgs.geojson`),
        target: { kind: 'existing', datasetId },
        schedule: '*/10 * * * *',
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    expect(created.json()).toMatchObject({ kind: 'feed', integrationId: null, datasetId })
    sourceId = created.json().id

    const result = await runJob(await sync(sourceId))
    expect(result).toMatchObject({ rows: 10, inserted: 10, updated: 0 })

    const rows = await rowsOf(datasetId)
    expect(rows.size).toBe(10)
    const rasht = rows.get('us7000tg5i')?.values
    expect(rasht).toMatchObject({
      source: 'USGS',
      magnitude: 4.6,
      occurred_at: new Date(USGS.features[9]?.properties.time as number).toISOString(),
      geometry: { type: 'Point', coordinates: [70.6552, 38.9879] },
    })
    // «24 km E of Rasht» — уже соседний Таджикабадский район
    expect(await codeOf(rasht?.district)).toBe('TJ-RA-11')
    // Событие в Афганистане района не получает
    expect(rows.get('us7000tj55')?.values.district).toBeNull()

    const source = await call(fx.app, { method: 'GET', url: `/sources/${sourceId}`, as: fx.admin })
    expect(source.json()).toMatchObject({ status: 'ok', rowCount: 10 })
  })

  it('повторный опрос тех же записей ничего не меняет', async () => {
    const result = await runJob(await sync(sourceId))
    expect(result).toMatchObject({ rows: 10, inserted: 0, updated: 0 })
    const runs = await call(fx.app, {
      method: 'GET',
      url: `/sources/${sourceId}/runs`,
      as: fx.admin,
    })
    expect(runs.json().items[0]).toMatchObject({
      status: 'succeeded',
      stats: { rows: 10, matched: 10, inserted: 0, updated: 0, unchanged: 10 },
    })
  })

  it('уточнение магнитуды меняет только поле ленты: статус дежурного остаётся', async () => {
    const before = (await rowsOf(datasetId)).get('us6000tx16')
    const marked = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${datasetId}/rows/${before?._id}`,
      as: fx.admin,
      payload: { values: { status: 'рассмотрено' }, ver: before?._ver },
    })
    expect(marked.statusCode, marked.body).toBe(200)

    const changed = structuredClone(USGS)
    const first = changed.features[0] as { properties: Record<string, unknown> }
    first.properties.mag = 4.9
    serve('/usgs.geojson', changed)
    const result = await runJob(await sync(sourceId))
    expect(result).toMatchObject({ inserted: 0, updated: 1 })

    const after = (await rowsOf(datasetId)).get('us6000tx16')?.values
    expect(after).toMatchObject({ magnitude: 4.9, status: 'рассмотрено' })
    serve('/usgs.geojson', USGS)
  })

  it('строку, удалённую вручную, лента заново не заводит', async () => {
    const row = (await rowsOf(datasetId)).get('us7000thvx')
    const removed = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/rows/delete`,
      as: fx.admin,
      payload: { ids: [row?._id] },
    })
    expect(removed.statusCode, removed.body).toBe(200)
    const result = await runJob(await sync(sourceId))
    expect(result.inserted).toBe(0)
    expect((await rowsOf(datasetId)).has('us7000thvx')).toBe(false)
  })

  it('опрашивает только ведущий источники: участнику — отказ, чужому ленты не найти', async () => {
    const member = await call(fx.app, {
      method: 'POST',
      url: `/sources/${sourceId}/sync`,
      as: fx.users.member,
    })
    expect(member.statusCode).toBe(403)
    const stranger = await call(fx.app, {
      method: 'POST',
      url: `/sources/${sourceId}/sync`,
      as: fx.users.stranger,
    })
    expect(stranger.statusCode).toBe(404)
  })

  it('сбой ленты — ошибка с причиной, статус источника «ошибка»', async () => {
    serve('/broken.geojson', '<html>не лента</html>', 200, 'text/html')
    serve('/down.geojson', '', 503, 'text/plain')
    for (const [path, reason] of [
      ['/broken.geojson', 'Ответ ленты — не JSON'],
      ['/down.geojson', 'Лента ответила кодом 503'],
    ] as const) {
      const patched = await call(fx.app, {
        method: 'PATCH',
        url: `/sources/${sourceId}`,
        as: fx.admin,
        payload: { feed: feedConfig(`${base}${path}`) },
      })
      expect(patched.statusCode, patched.body).toBe(200)
      const jobId = await sync(sourceId)
      await expect(runJob(jobId)).rejects.toThrow(reason)
      // Подписчик `job.failed` отмечает сбой источника — здесь вызываем его сами
      await SourceService.markFailed(sourceId, jobId, reason)
      const source = await call(fx.app, {
        method: 'GET',
        url: `/sources/${sourceId}`,
        as: fx.admin,
      })
      expect(source.json()).toMatchObject({ status: 'error', statusMessage: reason })
    }
    const check = await call(fx.app, {
      method: 'POST',
      url: `/sources/${sourceId}/check`,
      as: fx.admin,
    })
    expect(check.json()).toMatchObject({ ok: false, message: 'Лента ответила кодом 503' })
  })
})

describe('лента по адресу: территория и секреты', () => {
  it('«только внутри территорий» отбрасывает события соседних стран', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/sources/feeds',
      as: fx.admin,
      payload: {
        name: `USGS по стране ${run}`,
        spaceId: fx.spaceId,
        feed: feedConfig(`${base}/usgs.geojson`, { withinTerritory: true }),
        target: {
          kind: 'new',
          name: `Землетрясения в стране ${run}`,
          fields: [
            {
              key: 'event_id',
              label: { ru: 'Событие' },
              type: 'identifier',
              semantic: 'identifier',
              required: true,
            },
            { key: 'source', label: { ru: 'Источник' }, type: 'text' },
            { key: 'magnitude', label: { ru: 'Магнитуда' }, type: 'number', semantic: 'measure' },
            { key: 'place', label: { ru: 'Место' }, type: 'text' },
            { key: 'occurred_at', label: { ru: 'Время' }, type: 'datetime', semantic: 'time' },
            { key: 'geometry', label: { ru: 'Точка' }, type: 'geometry', semantic: 'geometry' },
            { key: 'district', label: { ru: 'Район' }, type: 'territory', semantic: 'territory' },
          ],
        },
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const datasetId = created.json().datasetId as string
    await runJob(await sync(created.json().id))
    const rows = await rowsOf(datasetId)
    expect(rows.has('us7000tg5i')).toBe(true)
    for (const outside of ['us7000tj55', 'us7000tj20', 'us7000ti97', 'us7000thgc', 'us7000thvx']) {
      expect(rows.has(outside), outside).toBe(false)
    }
    for (const row of rows.values()) {
      expect(await codeOf(row.values.district)).toMatch(/^TJ-/)
    }
  })

  it('ключ API подставляет интеграция: в настройке и ответах его нет', async () => {
    const key = `ключ-${run}`
    serve(`/secure/${encodeURIComponent(key)}/usgs.geojson`, USGS)
    const integration = await call(fx.app, {
      method: 'POST',
      url: '/integrations',
      as: fx.admin,
      payload: {
        key: `feed-secrets-${run}`,
        kind: 'http',
        name: `Секреты лент ${run}`,
        config: { url: base },
        secrets: { apiKey: key },
      },
    })
    expect(integration.statusCode, integration.body).toBe(200)
    const integrationId = integration.json().id as string
    const url = `${base}/secure/{secret:apiKey}/usgs.geojson`

    const preview = await call(fx.app, {
      method: 'POST',
      url: '/sources/feed/preview',
      as: fx.admin,
      payload: { url, format: 'geojson', integrationId },
    })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json().total).toBe(10)

    const datasetId = await createDataset(`С ключом ${run}`)
    const created = await call(fx.app, {
      method: 'POST',
      url: '/sources/feeds',
      as: fx.admin,
      payload: {
        name: `Лента с ключом ${run}`,
        spaceId: fx.spaceId,
        integrationId,
        feed: feedConfig(url),
        target: { kind: 'existing', datasetId },
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    expect(created.body).not.toContain(encodeURIComponent(key))
    expect(created.body).not.toContain(key)
    const result = await runJob(await sync(created.json().id))
    expect(result.inserted).toBe(10)
  })
})
