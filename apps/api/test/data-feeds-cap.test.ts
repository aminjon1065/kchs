import { readFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Лента CAP 1.2 (ADR-0201): индекс Atom со ссылками на сообщения, уточнение и
 * отмена пишутся в строку первичного сообщения по `references`, решение
 * дежурного лента не трогает, тест и черновик — не строки, заголовки ленты на
 * чужой адрес ссылки не уходят. Индекс GDACS — живой ответ со встроенными
 * сообщениями. Ленты — локальные серверы (адреса loopback тестовой среде открыты).
 */
registerLifecycle()

const { SourceService } = await import('../src/modules/data/domain/source-service.js')
const { JobService } = await import('../src/kernel/jobs/service.js')

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/feeds/cap/${name}`, import.meta.url), 'utf8')

let fx: TestContext
let own: Server
let foreign: Server
let base = ''
let other = ''
const run = Date.now().toString(36)
const responses = new Map<string, { status: number; type: string; body: string }>()
/** Заголовки запросов к чужому серверу — по пути. */
const foreignHeaders = new Map<string, IncomingHttpHeaders>()

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  )
}

const serve = (path: string, body: string, type = 'application/cap+xml', status = 200) =>
  responses.set(path, { status, type, body })

/** Сообщение CAP с областью-многоугольником в Душанбе. */
function alert(input: {
  identifier: string
  sent: string
  msgType?: string
  status?: string
  references?: string
  headline: string
  severity?: string
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>${input.identifier}</identifier>
  <sender>hydromet@example.tj</sender>
  <sent>${input.sent}</sent>
  <status>${input.status ?? 'Actual'}</status>
  <msgType>${input.msgType ?? 'Alert'}</msgType>
  <scope>Public</scope>
  ${input.references ? `<references>${input.references}</references>` : ''}
  <info>
    <language>ru-TJ</language>
    <category>Met</category>
    <event>Сильный дождь</event>
    <urgency>Expected</urgency>
    <severity>${input.severity ?? 'Moderate'}</severity>
    <certainty>Likely</certainty>
    <headline>${input.headline}</headline>
    <area>
      <areaDesc>г. Душанбе</areaDesc>
      <polygon>38.50,68.70 38.50,68.85 38.62,68.85 38.62,68.70 38.50,68.70</polygon>
    </area>
  </info>
</alert>`
}

const atom = (links: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Предупреждения</title>
  ${links.map((href, index) => `<entry><id>${index}</id><link type="application/cap+xml" href="${href}"/></entry>`).join('\n  ')}
</feed>`

beforeAll(async () => {
  fx = await setupFixture()
  own = createServer((request, response) => {
    const found = responses.get(request.url ?? '')
    if (!found) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(found.status, { 'content-type': found.type })
    response.end(found.body)
  })
  foreign = createServer((request, response) => {
    foreignHeaders.set(request.url ?? '', request.headers)
    response.writeHead(200, { 'content-type': 'application/cap+xml' })
    response.end(
      alert({
        identifier: `F-${run}`,
        sent: '2026-10-12T09:00:00+05:00',
        headline: 'Сообщение с чужого адреса',
      }),
    )
  })
  base = await listen(own)
  other = await listen(foreign)
})

afterAll(async () => {
  await new Promise((resolve) => own.close(resolve))
  await new Promise((resolve) => foreign.close(resolve))
})

async function createDataset(name: string): Promise<string> {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name,
      spaceId: fx.spaceId,
      fields: [
        {
          key: 'code',
          label: { ru: 'Код' },
          type: 'identifier',
          semantic: 'identifier',
          required: true,
        },
        { key: 'headline', label: { ru: 'Сообщение' }, type: 'text', semantic: 'text' },
        { key: 'severity', label: { ru: 'Тяжесть' }, type: 'text', semantic: 'category' },
        { key: 'msg_type', label: { ru: 'Вид сообщения' }, type: 'text', semantic: 'category' },
        { key: 'sent_at', label: { ru: 'Отправлено' }, type: 'datetime', semantic: 'time' },
        { key: 'geometry', label: { ru: 'Область' }, type: 'geometry', semantic: 'geometry' },
        { key: 'status', label: { ru: 'Решение' }, type: 'text', semantic: 'category' },
      ],
      primaryKey: ['code'],
      timeField: 'sent_at',
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  return created.json().id as string
}

const capFeed = (url: string, headers: Record<string, string> = {}) => ({
  url,
  headers,
  format: 'cap',
  mapping: [
    { field: 'code', value: { kind: 'path', path: 'key' } },
    { field: 'headline', value: { kind: 'path', path: 'info.headline' } },
    { field: 'severity', value: { kind: 'path', path: 'info.severity' } },
    { field: 'msg_type', value: { kind: 'path', path: 'msgType' } },
    { field: 'sent_at', value: { kind: 'path', path: 'sent' } },
  ],
  geometry: { kind: 'feature' },
  geometryField: 'geometry',
  keyFields: ['code'],
})

async function createFeed(name: string, datasetId: string, feed: Record<string, unknown>) {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/sources/feeds',
    as: fx.admin,
    payload: { name, spaceId: fx.spaceId, feed, target: { kind: 'existing', datasetId } },
  })
  expect(created.statusCode, created.body).toBe(200)
  return created.json().id as string
}

async function sync(sourceId: string) {
  const started = await call(fx.app, {
    method: 'POST',
    url: `/sources/${sourceId}/sync`,
    as: fx.admin,
  })
  expect(started.statusCode, started.body).toBe(200)
  const jobId = started.json().jobId as string
  const [row] = await db().execute<{ payload: { sourceId: string; runId: string } }>(
    sql`SELECT payload FROM jobs WHERE id = ${jobId}`,
  )
  await JobService.start(jobId)
  const result = await SourceService.execute(row?.payload as never, {
    recordId: jobId,
    progress: async () => undefined,
  })
  await JobService.finish(jobId, result)
  const [stats] = await db().execute<{ stats: Record<string, unknown> }>(
    sql`SELECT stats FROM source_runs WHERE id = ${row?.payload.runId}::uuid`,
  )
  return stats?.stats ?? {}
}

async function rowsOf(datasetId: string) {
  const response = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows/query`,
    as: fx.admin,
    payload: { limit: 100 },
  })
  expect(response.statusCode, response.body).toBe(200)
  const body = response.json() as { fields: Array<{ name: string }>; rows: unknown[][] }
  return body.rows.map((row) =>
    Object.fromEntries(body.fields.map((field, index) => [field.name, row[index]])),
  )
}

describe('лента CAP', () => {
  it('предпросмотр индекса GDACS: сообщения внутри индекса, пути info.* и геометрия', async () => {
    serve('/gdacs.rss', fixture('gdacs-cap.rss.xml'), 'application/rss+xml')
    const preview = await call(fx.app, {
      method: 'POST',
      url: '/sources/feed/preview',
      as: fx.admin,
      payload: { url: `${base}/gdacs.rss`, format: 'cap' },
    })
    expect(preview.statusCode, preview.body).toBe(200)
    const body = preview.json() as {
      total: number
      items: Array<Record<string, unknown>>
      paths: Array<{ path: string; type: string }>
    }
    expect(body.total).toBe(2)
    expect(body.items[0]).toMatchObject({ 'info.parameter.alertlevel': 'Green' })
    const types = new Map(body.paths.map((path) => [path.path, path.type]))
    expect(types.get('geometry')).toBe('geometry')
    expect(types.get('sent')).toBe('datetime')
  })

  it('индекс со ссылками: уточнение и отмена — в строку первичного сообщения, решение дежурного сохраняется', async () => {
    const id = `HM-${run}`
    const first = alert({
      identifier: id,
      sent: '2026-10-12T08:00:00+05:00',
      headline: 'Ожидается сильный дождь',
    })
    const update = alert({
      identifier: `${id}.2`,
      sent: '2026-10-12T09:00:00+05:00',
      msgType: 'Update',
      references: `hydromet@example.tj,${id},2026-10-12T08:00:00+05:00`,
      headline: 'Сильный дождь усилится',
      severity: 'Severe',
    })
    const test = alert({
      identifier: `T-${run}`,
      sent: '2026-10-12T09:30:00+05:00',
      status: 'Test',
      headline: 'Проверка канала',
    })
    serve('/cap/1.xml', first)
    serve('/cap/2.xml', update)
    serve('/cap/test.xml', test)
    serve('/cap/page.html', '<html><body>не CAP</body></html>', 'text/html')
    serve(
      '/cap/index.atom',
      atom(['/cap/1.xml', '/cap/2.xml', '/cap/test.xml', '/cap/page.html']),
      'application/atom+xml',
    )
    const datasetId = await createDataset(`Предупреждения CAP ${run}`)
    const sourceId = await createFeed(
      `Гидромет CAP ${run}`,
      datasetId,
      capFeed(`${base}/cap/index.atom`),
    )

    const stats = await sync(sourceId)
    expect(stats).toMatchObject({ inserted: 1 })
    expect(Number(stats.skipped)).toBeGreaterThanOrEqual(2)
    let rows = await rowsOf(datasetId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      code: `${id},2026-10-12T08:00:00+05:00`,
      headline: 'Сильный дождь усилится',
      severity: 'Severe',
      msg_type: 'Update',
    })
    expect(rows[0]?.geometry).toMatchObject({ type: 'Polygon' })

    // Дежурный принял решение — отмена его не затирает
    const decided = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${datasetId}/rows/${rows[0]?._id}`,
      as: fx.admin,
      payload: { values: { status: 'Принято к сведению' }, ver: Number(rows[0]?._ver) },
    })
    expect(decided.statusCode, decided.body).toBe(200)
    serve(
      '/cap/3.xml',
      alert({
        identifier: `${id}.3`,
        sent: '2026-10-12T12:00:00+05:00',
        msgType: 'Cancel',
        references: `hydromet@example.tj,${id},2026-10-12T08:00:00+05:00 hydromet@example.tj,${id}.2,2026-10-12T09:00:00+05:00`,
        headline: 'Предупреждение отменено',
      }),
    )
    serve('/cap/index.atom', atom(['/cap/3.xml']), 'application/atom+xml')
    expect(await sync(sourceId)).toMatchObject({ inserted: 0, updated: 1 })
    rows = await rowsOf(datasetId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      msg_type: 'Cancel',
      headline: 'Предупреждение отменено',
      status: 'Принято к сведению',
    })
  })

  it('заголовки ленты уходят только на её адрес, ссылке на чужой хост — без них', async () => {
    const path = `/foreign-${run}.xml`
    serve('/cap/mixed.atom', atom([`${other}${path}`]), 'application/atom+xml')
    const datasetId = await createDataset(`Чужие ссылки ${run}`)
    const sourceId = await createFeed(
      `Смешанный индекс ${run}`,
      datasetId,
      capFeed(`${base}/cap/mixed.atom`, { 'X-Feed-Token': 'feed-secret-token' }),
    )
    expect(await sync(sourceId)).toMatchObject({ inserted: 1 })
    expect(foreignHeaders.get(path)?.['x-feed-token']).toBeUndefined()
  })
})
